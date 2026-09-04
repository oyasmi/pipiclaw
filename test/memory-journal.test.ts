import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appendJournalEntries, getJournalPath, listJournalDates, readJournalDay } from "../src/memory/journal.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-memory-journal-");

describe("journal", () => {
	it("creates the day file with a header on first append", async () => {
		const channelDir = createTempDir();
		const result = await appendJournalEntries(channelDir, "2026-09-04", ["01:12 完成审查并发邮件"]);
		expect(result).toEqual({ appended: 1, skippedDuplicate: 0 });
		const content = await readFile(getJournalPath(channelDir, "2026-09-04"), "utf-8");
		expect(content).toBe("# 2026-09-04\n- 01:12 完成审查并发邮件\n");
	});

	it("appends without duplicating a normalized-equal existing line", async () => {
		const channelDir = createTempDir();
		await appendJournalEntries(channelDir, "2026-09-04", ["01:12 完成审查并发邮件"]);
		const result = await appendJournalEntries(channelDir, "2026-09-04", [
			"01:12   完成审查并发邮件", // same text, extra whitespace
			"04:20 简报改为工作日发送",
		]);
		expect(result).toEqual({ appended: 1, skippedDuplicate: 1 });
		const content = await readJournalDay(channelDir, "2026-09-04");
		expect(content.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(2);
	});

	it("keeps separate days in separate files and lists them sorted", async () => {
		const channelDir = createTempDir();
		await appendJournalEntries(channelDir, "2026-09-02", ["a"]);
		await appendJournalEntries(channelDir, "2026-09-04", ["b"]);
		expect(await listJournalDates(channelDir)).toEqual(["2026-09-02", "2026-09-04"]);
	});

	it("reads an absent day as empty text", async () => {
		const channelDir = createTempDir();
		expect(await readJournalDay(channelDir, "2026-01-01")).toBe("");
		expect(await listJournalDates(channelDir)).toEqual([]);
	});

	it("no-ops on an empty or all-duplicate batch", async () => {
		const channelDir = createTempDir();
		expect(await appendJournalEntries(channelDir, "2026-09-04", ["  ", ""])).toEqual({
			appended: 0,
			skippedDuplicate: 0,
		});
	});
});
