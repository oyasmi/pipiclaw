import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	closeSearchIndexes,
	getSearchIndexPath,
	SearchIndexUnavailableError,
	withSearchIndex,
} from "../src/memory/search-index-db.js";
import { syncDeskSearchIndex } from "../src/memory/search-index-sync.js";
import { searchDeskSessions } from "../src/memory/session-search.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { testModelRequests } from "./helpers/model-requests.js";

const temp = useTempDirs("pipiclaw-search-index-");
afterEach(closeSearchIndexes);

function fixture() {
	const appHomeDir = temp();
	const desk = "default";
	const deskDir = join(appHomeDir, "workspace", "desk-default");
	const dir = join(deskDir, "conversations", "dm-1");
	mkdirSync(dir, { recursive: true });
	const index = getSearchIndexPath(appHomeDir, desk);
	const target = { desk, deskDir, appHomeDir };
	const request = {
		...target,
		limit: 5,
		maxCharsPerChunk: 1200,
		timeoutMs: 1000,
		summarizeWithModel: false,
		model: {} as never,
		modelRequests: testModelRequests(),
	};
	return {
		index,
		dir,
		log: join(dir, "log.jsonl"),
		sync: () => syncDeskSearchIndex(target),
		search: (query: string) => searchDeskSessions({ ...request, query }),
	};
}
const row = (text: string) => `${JSON.stringify({ text, date: "2026-01-01T00:00:00Z" })}\n`;

describe("transcript index persistence", () => {
	it("commits only complete UTF-8 rows and preserves source bytes and mtime", async () => {
		const f = fixture();
		const tail = Buffer.from(row("后续锚点"));
		const split = tail.indexOf(Buffer.from("后")) + 1;
		writeFileSync(f.log, Buffer.concat([Buffer.from(row("第一条")), tail.subarray(0, split)]));
		const before = [createHash("sha256").update(readFileSync(f.log)).digest("hex"), statSync(f.log).mtimeMs];
		expect((await f.sync()).filesIndexed).toBe(1);
		expect((await f.search("后续锚点")).results).toEqual([]);
		expect([createHash("sha256").update(readFileSync(f.log)).digest("hex"), statSync(f.log).mtimeMs]).toEqual(before);
		appendFileSync(f.log, tail.subarray(split));
		const after = await f.search("后续锚点");
		expect(after.index.filesAppended).toBe(1);
		expect(after.results[0]).toMatchObject({ path: "conversations/dm-1/log.jsonl#L2", summary: "后续锚点" });
	});

	it("tracks log rotation by inode and keeps each reference once", async () => {
		const f = fixture();
		writeFileSync(f.log, row("before-rotation"));
		await f.sync();
		renameSync(f.log, `${f.log}.1`);
		writeFileSync(f.log, row("after-rotation"));
		expect(await f.sync()).toMatchObject({ filesIndexed: 1, filesRebuilt: 1 });
		expect((await f.search("before-rotation")).results[0]?.path).toContain("log.jsonl.1#L1");
		expect((await f.search("after-rotation")).results[0]?.path).toContain("log.jsonl#L1");
		await withSearchIndex(f.index, async ({ db }) => {
			expect(db.prepare("SELECT count(*) n FROM refs").get()).toMatchObject({ n: 2 });
		});
	});

	it("recognizes an in-place rewrite and truncation before indexing", async () => {
		const f = fixture();
		writeFileSync(f.log, row("rewrite-before"));
		await f.sync();
		writeFileSync(f.log, row("rewrite-second"));
		utimesSync(f.log, 10, 10);
		expect((await f.sync()).filesRebuilt).toBe(1);
		expect((await f.search("rewrite-before")).results).toEqual([]);
		expect((await f.search("rewrite-second")).results).toHaveLength(1);
		writeFileSync(f.log, row("short"));
		expect((await f.sync()).filesRebuilt).toBe(1);
		expect((await f.search("rewrite-second")).results).toEqual([]);
		expect((await f.search("short")).results).toHaveLength(1);
	});

	it("removes FTS postings only after their last reference has disappeared", async () => {
		const f = fixture();
		writeFileSync(f.log, row("uniquelexeme") + row("sharedlexeme"));
		writeFileSync(`${f.log}.1`, row("sharedlexeme"));
		await f.sync();
		unlinkSync(f.log);
		expect((await f.sync()).filesRemoved).toBe(1);
		await withSearchIndex(f.index, async ({ db }) => {
			expect(db.prepare("SELECT count(*) n FROM docs").get()).toMatchObject({ n: 1 });
			expect(db.prepare("SELECT count(*) n FROM docs_fts WHERE docs_fts MATCH 'uniquelexeme'").get()).toMatchObject({
				n: 0,
			});
			expect(db.prepare("SELECT count(*) n FROM docs_fts WHERE docs_fts MATCH 'sharedlexeme'").get()).toMatchObject({
				n: 1,
			});
			db.exec("INSERT INTO docs_fts(docs_fts, rank) VALUES ('integrity-check', 1)");
		});
	});

	it("resumes from committed progress after closing and reopening SQLite", async () => {
		const f = fixture();
		writeFileSync(f.log, row("persisted"));
		const before = await f.search("persisted");
		await closeSearchIndexes();
		const after = await f.search("persisted");
		expect(after.index).toMatchObject({ filesIndexed: 0, filesAppended: 0, filesRebuilt: 0 });
		expect(after.results).toEqual(before.results);
	});

	it("recovers a corrupt or incompatible database once per path", async () => {
		for (const damage of ["header", "version"]) {
			const f = fixture();
			writeFileSync(f.log, row("recoverable"));
			await f.sync();
			const corrupt = async () => {
				if (damage === "version")
					await withSearchIndex(f.index, async ({ db }) => db.exec("PRAGMA user_version = 99"));
				await closeSearchIndexes();
				if (damage === "header") writeFileSync(f.index, "invalid database");
			};
			await corrupt();
			expect((await f.search("recoverable")).results).toHaveLength(1);
			await corrupt();
			await expect(f.search("recoverable")).rejects.toBeInstanceOf(SearchIndexUnavailableError);
		}
	});

	it("reopens a database deleted while the cached connection is still active", async () => {
		const f = fixture();
		writeFileSync(f.log, row("delete-rebuild"));
		const before = await f.search("delete-rebuild");
		unlinkSync(f.index);
		const after = await f.search("delete-rebuild");
		expect(after.index.filesIndexed).toBe(1);
		expect(after.results).toEqual(before.results);
		expect(statSync(f.index).mode & 0o777).toBe(0o600);
	});

	it("serializes concurrent sync and query jobs without duplicating the committed rows", async () => {
		const f = fixture();
		writeFileSync(f.log, row("concurrent"));
		const [first, second, search] = await Promise.all([f.sync(), f.sync(), f.search("concurrent")]);
		expect(first.docsAdded + second.docsAdded + search.index.docsAdded).toBe(1);
		expect(search.results).toHaveLength(1);
		await withSearchIndex(f.index, async ({ db }) => {
			expect(db.prepare("SELECT count(*) n FROM refs").get()).toMatchObject({ n: 1 });
		});
	});
});
