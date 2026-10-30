import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	applyMemoryOps,
	clearMemoryStoreCache,
	getMemoryDir,
	getMemoryEntryPath,
	getMemoryIndexPath,
	isValidMemoryName,
	listMemoryEntries,
	parseMemoryFile,
	readMemoryEntry,
	renderMemoryIndex,
	serializeMemoryEntry,
	slugifyMemoryName,
} from "../src/memory/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-memory-store-");

async function seed(deskDir: string, name: string, raw: string): Promise<void> {
	await mkdir(getMemoryDir(deskDir), { recursive: true });
	await writeFile(getMemoryEntryPath(deskDir, name), raw, "utf-8");
	clearMemoryStoreCache();
}

describe("memory store — names", () => {
	it("validates the kebab shape", () => {
		expect(isValidMemoryName("deploy-window-thursday")).toBe(true);
		expect(isValidMemoryName("m-1a2b3c")).toBe(true);
		expect(isValidMemoryName("Deploy_Window")).toBe(false);
		expect(isValidMemoryName("-lead")).toBe(false);
		expect(isValidMemoryName("../escape")).toBe(false);
	});

	it("terminates a maximum-length collision in an isolated process", () => {
		// Risk: a valid conflicting name used to synchronously freeze the entire daemon.
		// Mutation 2026-10-31: truncating after the suffix causes the isolated child to time out.
		const moduleUrl = new URL("../src/memory/store.ts", import.meta.url).href;
		const script = `import { registerHooks } from 'node:module';
		registerHooks({ resolve(s, c, next) {
			return next(s.startsWith('.') && s.endsWith('.js') ? s.slice(0, -3) + '.ts' : s, c);
		} });
		const { dedupeMemoryName, isValidMemoryName } = await import(${JSON.stringify(moduleUrl)});
		const base = 'a'.repeat(60);
		const taken = [base, ...Array.from({length: 8}, (_, i) => 'a'.repeat(58) + '-' + (i + 2))];
		const result = dedupeMemoryName(base, taken);
		console.log(JSON.stringify({ result, valid: isValidMemoryName(result), taken: taken.includes(result) }));`;
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toMatchObject({ result: `${"a".repeat(57)}-10`, valid: true, taken: false });
	});

	it("slugifies free text and falls back to a hash", () => {
		expect(slugifyMemoryName("Deploy window is Thursday 20:00")).toBe("deploy-window-is-thursday-20-00");
		expect(slugifyMemoryName("用中文交流")).toMatch(/^m-[0-9a-f]{6}$/);
	});
});

describe("memory store — frontmatter round trip", () => {
	it("parses and re-serializes without loss", () => {
		const raw = serializeMemoryEntry({
			name: "deploy-window-thursday",
			description: "Prod deploy window is Thursday 20:00+",
			type: "project",
			source: "user",
			created: "2026-09-04",
			updated: "2026-09-04",
			body: "Emergency hotfix allowed any time after verbal confirmation.",
			malformed: false,
		});
		const parsed = parseMemoryFile("deploy-window-thursday", raw, "2026-01-01");
		expect(parsed.malformed).toBe(false);
		expect(parsed.description).toBe("Prod deploy window is Thursday 20:00+");
		expect(parsed.body).toContain("Emergency hotfix");
		expect(serializeMemoryEntry(parsed)).toBe(raw);
	});

	it("file name wins over a disagreeing frontmatter name", () => {
		const parsed = parseMemoryFile(
			"real-name",
			"---\nname: other\ndescription: x\ntype: user\nsource: user\ncreated: 2026-09-01\n---\n",
			"2026-01-01",
		);
		expect(parsed.name).toBe("real-name");
	});

	it("tolerates a file with no frontmatter: first paragraph becomes the description", () => {
		const parsed = parseMemoryFile(
			"legacy",
			"The CI runner moved to GitHub Actions.\n\nMore detail here.",
			"2026-02-02",
		);
		expect(parsed.description).toBe("The CI runner moved to GitHub Actions.");
		expect(parsed.type).toBe("project");
		expect(parsed.source).toBe("migrated");
		expect(parsed.malformed).toBe(true);
		expect(parsed.created).toBe("2026-02-02");
		expect(parsed.body).toBe("More detail here.");
	});
});

describe("memory store — index generation", () => {
	it("groups by type in canonical order, sorts by name, marks bodies with (+)", async () => {
		const deskDir = createTempDir();
		await seed(
			deskDir,
			"b-pref",
			"---\ndescription: no auto emoji\ntype: feedback\nsource: user\ncreated: 2026-09-01\n---\n",
		);
		await seed(
			deskDir,
			"a-lang",
			"---\ndescription: speak Chinese\ntype: user\nsource: user\ncreated: 2026-09-01\n---\n",
		);
		await seed(
			deskDir,
			"deploy",
			"---\ndescription: Thursday window\ntype: project\nsource: agent\ncreated: 2026-09-01\n---\n\nlong body\n",
		);
		const index = renderMemoryIndex(await listMemoryEntries(deskDir));
		const userHeading = index.indexOf("## user");
		const feedbackHeading = index.indexOf("## feedback");
		const projectHeading = index.indexOf("## project");
		expect(userHeading).toBeGreaterThanOrEqual(0);
		expect(feedbackHeading).toBeGreaterThanOrEqual(0);
		expect(projectHeading).toBeGreaterThanOrEqual(0);
		expect(userHeading).toBeLessThan(feedbackHeading);
		expect(feedbackHeading).toBeLessThan(projectHeading);
		expect(index).toContain("- deploy — Thursday window (+)");
		expect(index).toContain("- a-lang — speak Chinese");
	});
});

describe("memory store — mtime cache", () => {
	it("re-reads a file after its mtime changes", async () => {
		const deskDir = createTempDir();
		await mkdir(getMemoryDir(deskDir), { recursive: true });
		const path = getMemoryEntryPath(deskDir, "x");
		await writeFile(
			path,
			"---\ndescription: first\ntype: project\nsource: agent\ncreated: 2026-09-01\n---\n",
			"utf-8",
		);
		clearMemoryStoreCache();
		expect((await listMemoryEntries(deskDir))[0].description).toBe("first");

		await writeFile(
			path,
			"---\ndescription: second\ntype: project\nsource: agent\ncreated: 2026-09-01\n---\n",
			"utf-8",
		);
		const future = new Date(Date.now() + 5_000);
		await utimes(path, future, future);
		expect((await listMemoryEntries(deskDir))[0].description).toBe("second");
	});
});

describe("memory store — applyMemoryOps", () => {
	it("confines memory reads to valid regular entry files", async () => {
		const deskDir = createTempDir();
		await mkdir(getMemoryDir(deskDir), { recursive: true });
		const external = createTempDir();
		await seed(external, "private", "PRIVATE-DATA");
		await symlink(getMemoryEntryPath(external, "private"), getMemoryEntryPath(deskDir, "alias"));
		expect(await readMemoryEntry(deskDir, "alias")).toBeUndefined();
		expect((await listMemoryEntries(deskDir)).map((entry) => entry.name)).not.toContain("alias");
		await expect(readMemoryEntry(deskDir, "../private")).rejects.toThrow();
	});

	it("adds, dedupes the name, and rebuilds the index", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "lead", description: "user is the PM", source: "user", type: "user" },
		]);
		const result = await applyMemoryOps(deskDir, [
			{ op: "add", name: "lead", description: "second lead fact", source: "agent" },
		]);
		expect(result.added).toEqual(["lead-2"]);
		expect(result.renamed).toEqual([{ requested: "lead", used: "lead-2" }]);
		const third = await applyMemoryOps(deskDir, [
			{ op: "add", name: "lead", description: "third lead fact", source: "agent" },
		]);
		expect(third.added).toEqual(["lead-3"]);
		expect(await readFile(getMemoryIndexPath(deskDir), "utf-8")).toContain("- lead-2 — second lead fact");
	});

	it("update merges fields, bumps updated, and can clear probation", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "d", description: "old", source: "agent", expires: "2026-10-04" },
		]);
		await applyMemoryOps(deskDir, [{ op: "update", name: "d", description: "new", expires: null }], {
			today: "2026-09-20",
		});
		clearMemoryStoreCache();
		const entry = (await listMemoryEntries(deskDir))[0];
		expect(entry.description).toBe("new");
		expect(entry.updated).toBe("2026-09-20");
		expect(entry.expires).toBeUndefined();
	});

	it("touch clears probation and reports missing targets", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "p", description: "probationary", source: "agent", expires: "2026-10-04" },
		]);
		const result = await applyMemoryOps(deskDir, [{ op: "touch", names: ["p", "ghost"] }], {
			today: "2026-09-15",
		});
		expect(result.touched).toEqual(["p"]);
		expect(result.missingTarget).toBe(1);
		clearMemoryStoreCache();
		expect((await listMemoryEntries(deskDir))[0].expires).toBeUndefined();
	});

	it("lets an explicit user save through a tombstone and revokes it for the background pass too (batch 1.7)", async () => {
		// A tombstone must only stop the *background* reflect pass from silently re-learning a
		// forgotten fact — not the user's own explicit re-save. Mutation check: drop the
		// `op.source !== "user"` guard on the tombstone check and `userAdd.added` is empty.
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [{ op: "add", name: "gone", description: "obsolete fact", source: "agent" }]);
		await applyMemoryOps(deskDir, [{ op: "delete", name: "gone", reason: "user said so" }]);

		const userAdd = await applyMemoryOps(deskDir, [
			{ op: "add", name: "back", description: "Obsolete   fact", source: "user" },
		]);
		expect(userAdd.added).toEqual(["back"]);
		expect(userAdd.skippedTombstone).toBe(0);

		// The explicit save revokes the tombstone for later background reflection too.
		const { isDescriptionTombstoned } = await import("../src/memory/store.js");
		expect(await isDescriptionTombstoned(deskDir, "obsolete fact")).toBe(false);
		await applyMemoryOps(deskDir, [
			{ op: "delete", name: "back" },
			{ op: "add", name: "target", description: "another fact", source: "user" },
		]);
		const blocked = await applyMemoryOps(deskDir, [{ op: "update", name: "target", description: "obsolete fact" }]);
		expect(blocked.skippedTombstone).toBe(1);
		expect((await readMemoryEntry(deskDir, "target"))?.description).toBe("another fact");
		await applyMemoryOps(deskDir, [{ op: "update", name: "target", source: "user", description: "obsolete fact" }]);
		expect(await isDescriptionTombstoned(deskDir, "obsolete fact")).toBe(false);
	});

	it("rejects a description that looks like a secret", async () => {
		const deskDir = createTempDir();
		const result = await applyMemoryOps(deskDir, [
			{ op: "add", description: "api_key = abcdef1234567890", source: "user" },
		]);
		expect(result.added).toEqual([]);
		expect(result.skippedSecret).toBe(1);
	});
});
