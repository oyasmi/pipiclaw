import { cp, readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isChannelMigratedToV2,
	migrateChannelMemoryToV2,
	rollbackChannelMemoryV2,
} from "../src/memory/migrate.js";
import { clearMemoryStoreCache, listMemoryEntries } from "../src/memory/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/memory-v1", import.meta.url));
const createTempDir = useTempDirs("pipiclaw-memory-migrate-");

async function stageFixture(): Promise<string> {
	const channelDir = createTempDir();
	await cp(FIXTURE, channelDir, { recursive: true });
	clearMemoryStoreCache();
	return channelDir;
}

describe("memory migration v1 → v2", () => {
	it("converts MEMORY.md bullets to files with mapped type/source/dates", async () => {
		const channelDir = await stageFixture();
		const result = await migrateChannelMemoryToV2(channelDir, { today: "2026-09-04" });
		expect(result.migrated).toBe(true);

		clearMemoryStoreCache();
		const entries = await listMemoryEntries(channelDir);
		const byDesc = (needle: string) => entries.find((e) => e.description.includes(needle));

		expect(byDesc("speaks Chinese")?.type).toBe("user");
		expect(byDesc("report-only mode")?.type).toBe("feedback");
		expect(byDesc("claude CLI is installed")?.type).toBe("reference");
		expect(byDesc("Project scope")?.type).toBe("project");

		// user-sourced entry keeps source: user; agent/legacy become migrated
		expect(byDesc("claude CLI is installed")?.source).toBe("user");
		expect(byDesc("news briefing")?.source).toBe("migrated");

		// probationUntil → expires (as a local date)
		expect(byDesc("report-only mode")?.expires).toBe("2026-09-27");
	});

	it("folds indented bullets into the parent's body (F1 fix)", async () => {
		const channelDir = await stageFixture();
		await migrateChannelMemoryToV2(channelDir, { today: "2026-09-04" });
		clearMemoryStoreCache();
		const entries = await listMemoryEntries(channelDir);
		const role = entries.find((e) => e.description.includes("project manager"));
		expect(role?.body).toContain("capture/inspect regularly");
		expect(entries.some((e) => e.description === "capture/inspect regularly to track progress; step in when stuck")).toBe(
			false,
		);
	});

	it("routes Ongoing Work into today's journal, not memory", async () => {
		const channelDir = await stageFixture();
		await migrateChannelMemoryToV2(channelDir, { today: "2026-09-04" });
		clearMemoryStoreCache();
		const entries = await listMemoryEntries(channelDir);
		expect(entries.some((e) => e.description.includes("demo project source"))).toBe(false);
		const journal = await readFile(join(channelDir, "journal", "2026-09-04.md"), "utf-8");
		expect(journal).toContain("迁移自 MEMORY.md 的进行中事项");
		expect(journal).toContain("demo project source");
		expect(journal).toContain("迁移自 SESSION.md");
		expect(journal).toContain("PIPESTATUS is unsupported");
	});

	it("splits HISTORY into per-day journal files and one folded file", async () => {
		const channelDir = await stageFixture();
		await migrateChannelMemoryToV2(channelDir, { today: "2026-09-04" });
		expect(existsSync(join(channelDir, "journal", "2026-09-02.md"))).toBe(true);
		const day = await readFile(join(channelDir, "journal", "2026-09-02.md"), "utf-8");
		expect(day).toContain("- 01:10 2026-09-01: completed the read-only review");
		expect(existsSync(join(channelDir, "journal", "folded-through-2026-09-01.md"))).toBe(true);
	});

	it("carries tombstones over by contentHash", async () => {
		const channelDir = await stageFixture();
		const result = await migrateChannelMemoryToV2(channelDir, { today: "2026-09-04" });
		expect(result.tombstones).toBe(1);
		const tomb = await readFile(join(channelDir, "memory", ".tombstones.jsonl"), "utf-8");
		expect(tomb).toContain("b547ef7d1c7d5dbd9351cf2e1eb857cc86f58d66f6ea32a36a860641047ca90a");
		expect(tomb).not.toContain("m-deadbeef");
	});

	it("archives originals and is idempotent", async () => {
		const channelDir = await stageFixture();
		await migrateChannelMemoryToV2(channelDir, { today: "2026-09-04" });
		expect(isChannelMigratedToV2(channelDir)).toBe(true);
		expect(existsSync(join(channelDir, ".memory-v1", "MEMORY.md"))).toBe(true);
		expect(existsSync(join(channelDir, ".memory-v1", ".memory", "entries.json"))).toBe(true);

		const filesAfterFirst = (await readdir(join(channelDir, "memory"))).sort();
		const second = await migrateChannelMemoryToV2(channelDir, { today: "2026-09-05" });
		expect(second.migrated).toBe(false);
		expect(second.reason).toBe("already-migrated");
		expect((await readdir(join(channelDir, "memory"))).sort()).toEqual(filesAfterFirst);
	});

	it("rolls back to byte-identical originals", async () => {
		const channelDir = await stageFixture();
		const before = await readFile(join(channelDir, "MEMORY.md"), "utf-8");
		await migrateChannelMemoryToV2(channelDir, { today: "2026-09-04" });
		await rollbackChannelMemoryV2(channelDir);
		expect(await readFile(join(channelDir, "MEMORY.md"), "utf-8")).toBe(before);
		expect(existsSync(join(channelDir, "memory"))).toBe(false);
		expect(existsSync(join(channelDir, "journal"))).toBe(false);
		expect(existsSync(join(channelDir, ".memory-v1"))).toBe(false);
		expect(existsSync(join(channelDir, ".memory", "entries.json"))).toBe(true);
	});

	it("does nothing for a channel with no v1 layout", async () => {
		const channelDir = createTempDir();
		const result = await migrateChannelMemoryToV2(channelDir);
		expect(result.migrated).toBe(false);
		expect(result.reason).toBe("nothing-to-migrate");
		expect(isChannelMigratedToV2(channelDir)).toBe(false);
	});
});
