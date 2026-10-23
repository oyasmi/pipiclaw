import { describe, expect, it, vi } from "vitest";
import { handleMemoryCommand } from "../src/memory/commands.js";
import { appendJournalEntries } from "../src/memory/journal.js";
import { applyMemoryOps, listMemoryEntries } from "../src/memory/store.js";
import { testConversation, useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-memory-commands-");

async function run(deskDir: string, args: string, appHomeDir?: string) {
	return handleMemoryCommand({ conversation: testConversation(deskDir), appHomeDir, args });
}

describe("/memory list", () => {
	it("filters by type and rejects an unknown type", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "a", type: "user", description: "user fact", source: "user" },
			{ op: "add", name: "b", type: "project", description: "project fact", source: "agent" },
		]);
		const filtered = await run(deskDir, "list user");
		expect(filtered).toContain("`a`");
		expect(filtered).not.toContain("`b`");

		const bad = await run(deskDir, "list bogus");
		expect(bad).toContain("未知的记忆类型");
	});
});

describe("/memory show", () => {
	it("shows full frontmatter and body, and reports a missing name", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [
			{ op: "add", name: "x", type: "reference", description: "a fact", source: "user", details: "extra detail" },
		]);
		const shown = await run(deskDir, "show x");
		expect(shown).toContain("`reference`");
		expect(shown).toContain("`user`");
		expect(shown).toContain("a fact");
		expect(shown).toContain("extra detail");

		const missing = await run(deskDir, "show ghost");
		expect(missing).toContain("未找到记忆");
	});
});

describe("/memory forget", () => {
	it("deletes without calling the model, tombstones it, and blocks a later identical add", async () => {
		const deskDir = createTempDir();
		await applyMemoryOps(deskDir, [{ op: "add", name: "gone", description: "obsolete fact", source: "user" }]);
		const result = await run(deskDir, "forget gone");
		expect(result).toContain("已删除");
		expect(await listMemoryEntries(deskDir)).toHaveLength(0);

		// The tombstone matches on the normalized description, not the exact spelling.
		const readd = await applyMemoryOps(deskDir, [{ op: "add", description: "Obsolete   fact", source: "agent" }]);
		expect(readd.added).toEqual([]);
		expect(readd.skippedTombstone).toBe(1);
		expect(await run(deskDir, "forget ghost")).toContain("未找到记忆");
		expect(await listMemoryEntries(deskDir)).toEqual([]);
	});
});

describe("/memory journal", () => {
	it("shows today by default and an explicit date, with a hint when empty", async () => {
		const deskDir = createTempDir();
		const todayKey = "2026-09-04";
		await appendJournalEntries(deskDir, todayKey, ["01:00 today sentinel"]);
		await appendJournalEntries(deskDir, "2026-09-03", ["22:00 other-day sentinel"]);
		vi.useFakeTimers({ now: new Date("2026-09-04T12:00:00+08:00") });
		try {
			const today = await run(deskDir, "journal");
			const explicit = await run(deskDir, "journal 2026-09-03");
			expect(today).toContain("today sentinel");
			expect(today).not.toContain("other-day sentinel");
			expect(explicit).toContain("other-day sentinel");
		} finally {
			vi.useRealTimers();
		}

		const empty = await run(deskDir, "journal 2020-01-01");
		expect(empty).toContain("2026-09-04");
		expect(await run(deskDir, "journal not-a-date")).toContain("日期格式");
	});
});
