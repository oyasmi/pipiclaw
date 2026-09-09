import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	appendJournalEntries,
	getJournalPath,
	JOURNAL_SEARCH_DAY_BYTES,
	JOURNAL_SEARCH_MAX_DAYS,
	listJournalDates,
	readJournalDay,
	readJournalForSearch,
} from "../src/memory/journal.js";
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

	it("bounds search by newest files and whole tail lines, including oversized UTF-8 entries", async () => {
		const channelDir = createTempDir();
		await mkdir(`${channelDir}/journal`);
		for (let day = 1; day <= JOURNAL_SEARCH_MAX_DAYS + 1; day++) {
			await writeFile(getJournalPath(channelDir, `2026-08-${String(day).padStart(2, "0")}`), `- day ${day}\n`);
		}
		await writeFile(
			getJournalPath(channelDir, "2026-08-31"),
			`- old evidence\n- ${"汉".repeat(JOURNAL_SEARCH_DAY_BYTES)}\n- newest evidence\n`,
		);
		await writeFile(`${channelDir}/journal/unrelated.txt`, "not a journal");
		const result = await readJournalForSearch(channelDir);
		expect(result.days).toHaveLength(JOURNAL_SEARCH_MAX_DAYS);
		expect(result.omittedDays).toBe(1);
		expect(result.truncatedDates).toEqual(["2026-08-31"]);
		expect(result.days[0]).toEqual({ date: "2026-08-31", content: "- newest evidence\n" });
		expect(result.days.at(-1)?.date).toBe("2026-08-02");
		expect(result.days.every((day) => Buffer.byteLength(day.content) <= JOURNAL_SEARCH_DAY_BYTES)).toBe(true);
	});

	it("does not hide a broken journal directory as an empty search", async () => {
		const channelDir = createTempDir();
		await writeFile(`${channelDir}/journal`, "not a directory");
		await expect(readJournalForSearch(channelDir)).rejects.toMatchObject({ code: "ENOTDIR" });
		expect(await readJournalForSearch(createTempDir())).toEqual({ days: [], omittedDays: 0, truncatedDates: [] });
	});

	it("no-ops on an empty or all-duplicate batch", async () => {
		const channelDir = createTempDir();
		expect(await appendJournalEntries(channelDir, "2026-09-04", ["  ", ""])).toEqual({
			appended: 0,
			skippedDuplicate: 0,
		});
	});
});
