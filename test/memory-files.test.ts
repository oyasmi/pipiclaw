import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendChannelHistoryBlock,
	appendChannelMemoryUpdate,
	ensureChannelMemoryFilesSync,
	readChannelHistory,
	readChannelMemory,
	readChannelSession,
	rewriteChannelHistory,
	rewriteChannelMemory,
	rewriteChannelSession,
	splitMarkdownSections,
} from "../src/memory-files.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-memory-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("memory-files", () => {
	it("creates default memory, session, and history files", async () => {
		const channelDir = createTempDir();
		ensureChannelMemoryFilesSync(channelDir);

		const memory = await readChannelMemory(channelDir);
		const session = await readChannelSession(channelDir);
		const history = await readChannelHistory(channelDir);

		expect(memory).toContain("# Channel Memory");
		expect(session).toContain("# Current State");
		expect(history).toContain("# Channel History");
	});

	it("rewrites files and falls back to defaults on blank content", async () => {
		const channelDir = createTempDir();

		await rewriteChannelMemory(channelDir, "## Notes\n\n- durable fact");
		await rewriteChannelSession(channelDir, "# Session Title\n\nHot task");
		await rewriteChannelHistory(channelDir, "## 2026-01-01\n\nSummary");
		expect(await readChannelMemory(channelDir)).toContain("durable fact");
		expect(await readChannelSession(channelDir)).toContain("Hot task");
		expect(await readChannelHistory(channelDir)).toContain("Summary");

		await rewriteChannelMemory(channelDir, "   ");
		await rewriteChannelSession(channelDir, "");
		await rewriteChannelHistory(channelDir, "");
		expect(await readChannelMemory(channelDir)).toContain("# Channel Memory");
		expect(await readChannelSession(channelDir)).toContain("# Current State");
		expect(await readChannelHistory(channelDir)).toContain("# Channel History");
	});

	it("appends memory and history blocks and ignores empty history updates", async () => {
		const channelDir = createTempDir();

		await appendChannelMemoryUpdate(channelDir, {
			timestamp: "2026-03-31T00:00:00.000Z",
			entries: ["Keep this", "And this"],
		});
		await appendChannelHistoryBlock(channelDir, {
			timestamp: "2026-03-31T00:00:00.000Z",
			content: "Past summary",
		});
		await appendChannelHistoryBlock(channelDir, {
			timestamp: "2026-03-31T00:00:00.000Z",
			content: "   ",
		});

		const memory = readFileSync(join(channelDir, "MEMORY.md"), "utf-8");
		const history = readFileSync(join(channelDir, "HISTORY.md"), "utf-8");

		expect(memory).toContain("## Update 2026-03-31T00:00:00.000Z");
		expect(memory).toContain("- Keep this");
		expect(history).toContain("## 2026-03-31T00:00:00.000Z");
		expect(history.match(/## 2026-03-31T00:00:00.000Z/g)).toHaveLength(1);
	});

	it("splits markdown sections by level-two headings", () => {
		expect(
			splitMarkdownSections(`# Root

## First

Alpha

## Second

Beta`),
		).toEqual([
			{ heading: "First", content: "Alpha" },
			{ heading: "Second", content: "Beta" },
		]);
		expect(splitMarkdownSections("")).toEqual([]);
	});
});
