import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendMemoryReviewLog, getMemoryReviewLogPath } from "../src/memory/review-log.js";
import { createTempWorkspace } from "./helpers/fixtures.js";

const tempDirs: string[] = [];

function createChannelDir(): string {
	const workspaceDir = createTempWorkspace("pipiclaw-review-rotation-");
	tempDirs.push(workspaceDir);
	return join(workspaceDir, "dm_123");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("review log rotation", () => {
	it("rotates when file exceeds 1MB", async () => {
		const channelDir = createChannelDir();
		await mkdir(channelDir, { recursive: true });
		const logPath = getMemoryReviewLogPath(channelDir);

		// Write a file just under 1MB
		const bigLine = JSON.stringify({
			timestamp: "2026-01-01T00:00:00.000Z",
			channelId: "dm_123",
			reason: "idle",
			candidates: [{ content: "x".repeat(500) }],
		});
		const lines = Array.from({ length: Math.ceil(1_100_000 / (bigLine.length + 1)) }, () => bigLine);
		writeFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

		const sizeBefore = readFileSync(logPath, "utf-8").length;
		expect(sizeBefore).toBeGreaterThan(1_024 * 1_024);

		// Append one more entry to trigger rotation
		await appendMemoryReviewLog(channelDir, {
			timestamp: "2026-04-19T00:00:00.000Z",
			channelId: "dm_123",
			reason: "post-turn",
			actions: [{ target: "MEMORY.md" }],
		});

		const sizeAfter = readFileSync(logPath, "utf-8").length;
		expect(sizeAfter).toBeLessThan(sizeBefore);
		const activeContent = readFileSync(logPath, "utf-8");
		expect(activeContent).toContain("2026-04-19T00:00:00.000Z");
		expect(activeContent.trim().split("\n")).toHaveLength(1);

		// Rotated file should exist
		const rotatedPath = `${logPath}.1`;
		const rotatedContent = readFileSync(rotatedPath, "utf-8");
		expect(rotatedContent.trim().split("\n").length).toBeGreaterThan(0);
	});
});
