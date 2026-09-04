import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	applyMemoryOps,
	clearMemoryStoreCache,
	dedupeMemoryName,
	getChannelMemoryDir,
	getChannelMemoryIndexPath,
	getMemoryEntryPath,
	isValidMemoryName,
	listMemoryEntries,
	parseMemoryFile,
	rebuildMemoryIndex,
	renderMemoryIndex,
	serializeMemoryEntry,
	slugifyMemoryName,
} from "../src/memory/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-memory-store-");

async function seed(channelDir: string, name: string, raw: string): Promise<void> {
	await mkdir(getChannelMemoryDir(channelDir), { recursive: true });
	await writeFile(getMemoryEntryPath(channelDir, name), raw, "utf-8");
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

	it("slugifies free text and falls back to a hash", () => {
		expect(slugifyMemoryName("Deploy window is Thursday 20:00")).toBe("deploy-window-is-thursday-20-00");
		expect(slugifyMemoryName("用中文交流")).toMatch(/^m-[0-9a-f]{6}$/);
	});

	it("dedupes against taken names", () => {
		expect(dedupeMemoryName("lead", ["lead", "lead-2"])).toBe("lead-3");
		expect(dedupeMemoryName("free", ["lead"])).toBe("free");
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
		const parsed = parseMemoryFile("real-name", "---\nname: other\ndescription: x\ntype: user\nsource: user\ncreated: 2026-09-01\n---\n", "2026-01-01");
		expect(parsed.name).toBe("real-name");
	});

	it("tolerates a file with no frontmatter: first paragraph becomes the description", () => {
		const parsed = parseMemoryFile("legacy", "The CI runner moved to GitHub Actions.\n\nMore detail here.", "2026-02-02");
		expect(parsed.description).toBe("The CI runner moved to GitHub Actions.");
		expect(parsed.type).toBe("project");
		expect(parsed.source).toBe("migrated");
		expect(parsed.malformed).toBe(true);
		expect(parsed.created).toBe("2026-02-02");
		expect(parsed.body).toBe("More detail here.");
	});

	it("collapses a multi-line description to one line", () => {
		const parsed = parseMemoryFile("x", "---\ndescription: line one\ntype: user\nsource: user\ncreated: 2026-09-01\n---\n", "2026-01-01");
		expect(parsed.description).toBe("line one");
	});
});

describe("memory store — index generation", () => {
	it("groups by type in canonical order, sorts by name, marks bodies with (+)", async () => {
		const channelDir = createTempDir();
		await seed(channelDir, "b-pref", "---\ndescription: no auto emoji\ntype: feedback\nsource: user\ncreated: 2026-09-01\n---\n");
		await seed(channelDir, "a-lang", "---\ndescription: speak Chinese\ntype: user\nsource: user\ncreated: 2026-09-01\n---\n");
		await seed(
			channelDir,
			"deploy",
			"---\ndescription: Thursday window\ntype: project\nsource: agent\ncreated: 2026-09-01\n---\n\nlong body\n",
		);
		const index = renderMemoryIndex(await listMemoryEntries(channelDir));
		expect(index.indexOf("## user")).toBeLessThan(index.indexOf("## feedback"));
		expect(index.indexOf("## feedback")).toBeLessThan(index.indexOf("## project"));
		expect(index).toContain("- deploy — Thursday window (+)");
		expect(index).toContain("- a-lang — speak Chinese");
	});

	it("rebuilds MEMORY.md from the files", async () => {
		const channelDir = createTempDir();
		await seed(channelDir, "x", "---\ndescription: fact x\ntype: project\nsource: agent\ncreated: 2026-09-01\n---\n");
		await rebuildMemoryIndex(channelDir);
		expect(await readFile(getChannelMemoryIndexPath(channelDir), "utf-8")).toContain("- x — fact x");
	});
});

describe("memory store — mtime cache", () => {
	it("re-reads a file after its mtime changes", async () => {
		const channelDir = createTempDir();
		await mkdir(getChannelMemoryDir(channelDir), { recursive: true });
		const path = getMemoryEntryPath(channelDir, "x");
		await writeFile(path, "---\ndescription: first\ntype: project\nsource: agent\ncreated: 2026-09-01\n---\n", "utf-8");
		clearMemoryStoreCache();
		expect((await listMemoryEntries(channelDir))[0].description).toBe("first");

		await writeFile(path, "---\ndescription: second\ntype: project\nsource: agent\ncreated: 2026-09-01\n---\n", "utf-8");
		const future = new Date(Date.now() + 5_000);
		await utimes(path, future, future);
		expect((await listMemoryEntries(channelDir))[0].description).toBe("second");
	});
});

describe("memory store — applyMemoryOps", () => {
	it("adds, dedupes the name, and rebuilds the index", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "lead", description: "user is the PM", source: "user", type: "user" },
		]);
		const result = await applyMemoryOps(channelDir, [
			{ op: "add", name: "lead", description: "second lead fact", source: "agent" },
		]);
		expect(result.added).toEqual(["lead-2"]);
		expect(result.renamed).toEqual([{ requested: "lead", used: "lead-2" }]);
		expect(await readFile(getChannelMemoryIndexPath(channelDir), "utf-8")).toContain("- lead-2 — second lead fact");
	});

	it("update merges fields, bumps updated, and can clear probation", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "d", description: "old", source: "agent", expires: "2026-10-04" },
		]);
		await applyMemoryOps(channelDir, [{ op: "update", name: "d", description: "new", expires: null }], {
			today: "2026-09-20",
		});
		clearMemoryStoreCache();
		const entry = (await listMemoryEntries(channelDir))[0];
		expect(entry.description).toBe("new");
		expect(entry.updated).toBe("2026-09-20");
		expect(entry.expires).toBeUndefined();
	});

	it("touch clears probation and reports missing targets", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "p", description: "probationary", source: "agent", expires: "2026-10-04" },
		]);
		const result = await applyMemoryOps(channelDir, [{ op: "touch", names: ["p", "ghost"] }], { today: "2026-09-15" });
		expect(result.touched).toEqual(["p"]);
		expect(result.missingTarget).toBe(1);
		clearMemoryStoreCache();
		expect((await listMemoryEntries(channelDir))[0].expires).toBeUndefined();
	});

	it("delete writes a tombstone that blocks a later re-add of the same description", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [{ op: "add", name: "gone", description: "obsolete fact", source: "agent" }]);
		await applyMemoryOps(channelDir, [{ op: "delete", name: "gone", reason: "user said so" }]);
		const result = await applyMemoryOps(channelDir, [
			{ op: "add", name: "back", description: "Obsolete   fact", source: "agent" },
		]);
		expect(result.added).toEqual([]);
		expect(result.skippedTombstone).toBe(1);
	});

	it("rejects a description that looks like a secret", async () => {
		const channelDir = createTempDir();
		const result = await applyMemoryOps(channelDir, [
			{ op: "add", description: "api_key = abcdef1234567890", source: "user" },
		]);
		expect(result.added).toEqual([]);
		expect(result.skippedSecret).toBe(1);
	});
});
