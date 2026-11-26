import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { appendJournalEntries, getJournalPath, listJournalDates, readJournalDay } from "../src/memory/journal.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-memory-journal-");

describe("journal", () => {
	it("appends without duplicating a normalized-equal existing line", async () => {
		const deskDir = createTempDir();
		expect(await appendJournalEntries(deskDir, "2026-09-04", ["01:12 完成审查并发邮件"])).toEqual({
			appended: 1,
			skippedDuplicate: 0,
		});
		expect(await readFile(getJournalPath(deskDir, "2026-09-04"), "utf-8")).toBe(
			"# 2026-09-04\n- 01:12 完成审查并发邮件\n",
		);
		const result = await appendJournalEntries(deskDir, "2026-09-04", [
			"01:12   完成审查并发邮件", // same text, extra whitespace
			"04:20 简报改为工作日发送",
		]);
		expect(result).toEqual({ appended: 1, skippedDuplicate: 1 });
		const content = await readJournalDay(deskDir, "2026-09-04");
		expect(content.split("\n").filter((l) => l.startsWith("-"))).toHaveLength(2);
		await appendJournalEntries(deskDir, "2026-09-04", ["api_key = abcdef1234567890"]);
		expect(await readJournalDay(deskDir, "2026-09-04")).not.toContain("abcdef1234567890");
	});

	it("keeps separate days in separate files and lists them sorted", async () => {
		const deskDir = createTempDir();
		await appendJournalEntries(deskDir, "2026-09-02", ["a"]);
		await appendJournalEntries(deskDir, "2026-09-04", ["b"]);
		expect(await listJournalDates(deskDir)).toEqual(["2026-09-02", "2026-09-04"]);
	});

	it("reads an absent day as empty text", async () => {
		const deskDir = createTempDir();
		expect(await readJournalDay(deskDir, "2026-01-01")).toBe("");
		expect(await listJournalDates(deskDir)).toEqual([]);
	});

	it("no-ops on an empty or all-duplicate batch", async () => {
		const deskDir = createTempDir();
		await appendJournalEntries(deskDir, "2026-09-04", ["01:12 completed review"]);
		const path = getJournalPath(deskDir, "2026-09-04");
		const before = await readFile(path, "utf-8");
		expect(await appendJournalEntries(deskDir, "2026-09-04", ["  ", ""])).toEqual({
			appended: 0,
			skippedDuplicate: 0,
		});
		expect(await appendJournalEntries(deskDir, "2026-09-04", ["01:12   completed review"])).toEqual({
			appended: 0,
			skippedDuplicate: 1,
		});
		expect(await readFile(path, "utf-8")).toBe(before);
	});
});
