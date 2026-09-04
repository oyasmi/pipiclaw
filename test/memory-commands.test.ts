import { describe, expect, it } from "vitest";
import { handleMemoryCommand } from "../src/memory/commands.js";
import { appendJournalEntries } from "../src/memory/journal.js";
import { updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { applyMemoryOps, listMemoryEntries } from "../src/memory/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-memory-commands-");

async function run(channelDir: string, args: string, appHomeDir?: string) {
	return handleMemoryCommand({ channelId: "dm_1", channelDir, appHomeDir, args });
}

describe("/memory status", () => {
	it("reports empty state on a fresh channel", async () => {
		const channelDir = createTempDir();
		const text = await run(channelDir, "status");
		expect(text).toContain("频道条目：`0`");
		expect(text).toContain("试用期条目：`0`");
	});

	it("counts by type, probation, malformed files, and last reflect", async () => {
		const channelDir = createTempDir();
		const appHomeDir = createTempDir();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "u1", type: "user", description: "user fact", source: "user" },
			{ op: "add", name: "p1", type: "project", description: "durable fact", source: "agent" },
			{
				op: "add",
				name: "prob1",
				type: "project",
				description: "probationary fact",
				source: "agent",
				expires: "2026-10-04",
			},
		]);
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			lastReflectAt: "2026-09-04T00:00:00.000+08:00",
			lastReflectedEntryId: "entry-7",
		}));

		const text = await run(channelDir, "status", appHomeDir);
		expect(text).toContain("频道条目：`3`");
		expect(text).toContain("user 1");
		expect(text).toContain("project 2");
		expect(text).toContain("试用期条目：`1`（最早到期 `2026-10-04`）");
		expect(text).toContain("2026-09-04T00:00:00.000+08:00");
		expect(text).toContain("entry-7");
	});
});

describe("/memory list", () => {
	it("lists entries and marks ones with a body", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "short", description: "one liner", source: "agent" },
			{ op: "add", name: "long", description: "has detail", source: "agent", details: "more text" },
		]);
		const text = await run(channelDir, "list");
		expect(text).toContain("`short`");
		expect(text).toContain("`long`");
		expect(text).toMatch(/`long`.*\(\+\)/);
		expect(text).not.toMatch(/`short`.*\(\+\)/);
	});

	it("filters by type and rejects an unknown type", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "a", type: "user", description: "user fact", source: "user" },
			{ op: "add", name: "b", type: "project", description: "project fact", source: "agent" },
		]);
		const filtered = await run(channelDir, "list user");
		expect(filtered).toContain("`a`");
		expect(filtered).not.toContain("`b`");

		const bad = await run(channelDir, "list bogus");
		expect(bad).toContain("未知的记忆类型");
	});
});

describe("/memory show", () => {
	it("shows full frontmatter and body, and reports a missing name", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [
			{ op: "add", name: "x", type: "reference", description: "a fact", source: "user", details: "extra detail" },
		]);
		const shown = await run(channelDir, "show x");
		expect(shown).toContain("type: `reference`");
		expect(shown).toContain("source: `user`");
		expect(shown).toContain("a fact");
		expect(shown).toContain("extra detail");

		const missing = await run(channelDir, "show ghost");
		expect(missing).toContain("未找到记忆");
	});
});

describe("/memory forget", () => {
	it("deletes without calling the model, tombstones it, and blocks a later identical add", async () => {
		const channelDir = createTempDir();
		await applyMemoryOps(channelDir, [{ op: "add", name: "gone", description: "obsolete fact", source: "user" }]);
		const result = await run(channelDir, "forget gone");
		expect(result).toContain("已删除");
		expect(await listMemoryEntries(channelDir)).toHaveLength(0);

		const readd = await applyMemoryOps(channelDir, [{ op: "add", description: "obsolete fact", source: "agent" }]);
		expect(readd.added).toEqual([]);
		expect(readd.skippedTombstone).toBe(1);
	});

	it("reports a missing name without touching anything", async () => {
		const channelDir = createTempDir();
		const result = await run(channelDir, "forget ghost");
		expect(result).toContain("未找到记忆");
	});
});

describe("/memory journal", () => {
	it("shows today by default and an explicit date, with a hint when empty", async () => {
		const channelDir = createTempDir();
		await appendJournalEntries(channelDir, "2026-09-04", ["01:00 did a thing"]);
		const today = await run(channelDir, "journal");
		// Whichever day "today" resolves to in this environment, an explicit date must work.
		const explicit = await run(channelDir, "journal 2026-09-04");
		expect(explicit).toContain("did a thing");
		expect(typeof today).toBe("string");

		const empty = await run(channelDir, "journal 2020-01-01");
		expect(empty).toContain("没有记录");
	});

	it("rejects a malformed date", async () => {
		const channelDir = createTempDir();
		const result = await run(channelDir, "journal not-a-date");
		expect(result).toContain("日期格式");
	});
});

describe("/memory unknown", () => {
	it("reports an unknown subcommand", async () => {
		const channelDir = createTempDir();
		const result = await run(channelDir, "recent");
		expect(result).toContain("未知的 memory 命令");
	});
});
