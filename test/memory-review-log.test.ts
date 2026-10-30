import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMemoryReviewLog, getMemoryReviewLogPath } from "../src/memory/review-log.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-review-log-");

function createChannelDir(): string {
	return join(createTempDir(), "dingtalk:dm:123");
}

describe("memory review log", () => {
	it("serializes concurrent appends without corrupting JSONL", async () => {
		const deskDir = createChannelDir();

		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				appendMemoryReviewLog(deskDir, {
					timestamp: `2026-04-19T00:00:0${index}.000Z`,
					channelId: "dingtalk:dm:123",
					reason: "reflect",
					actions: [{ index }],
				}),
			),
		);

		const lines = readFileSync(join(deskDir, "memory-review.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(8);
		const entries = lines.map((line) => JSON.parse(line) as { timestamp: string; actions: Array<{ index: number }> });
		expect(entries.map((entry) => entry.actions[0]?.index).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(new Set(entries.map((entry) => entry.timestamp)).size).toBe(8);
	});

	it("deduplicates consecutive identical gate skips", async () => {
		const deskDir = createChannelDir();
		const base = {
			channelId: "dingtalk:dm:123",
			reason: "reflect" as const,
			skipped: [{ target: "reflect", reason: "clean" }],
		};
		await appendMemoryReviewLog(deskDir, { ...base, timestamp: "2026-04-19T00:00:00.000Z" });
		await appendMemoryReviewLog(deskDir, { ...base, timestamp: "2026-04-19T00:01:00.000Z" });
		const lines = readFileSync(join(deskDir, "memory-review.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
	});
});

describe("review log rotation", () => {
	it("rotates an oversized log, retaining whole recent records in order", async () => {
		const deskDir = createChannelDir();
		await mkdir(deskDir, { recursive: true });
		const logPath = getMemoryReviewLogPath(deskDir);

		// Cross the rotation threshold with complete records.
		const lines = Array.from({ length: 2_000 }, (_, index) =>
			JSON.stringify({
				timestamp: "2026-01-01T00:00:00.000Z",
				channelId: "dingtalk:dm:123",
				reason: "reflect",
				actions: [{ index, content: "x".repeat(500) }],
			}),
		);
		const previous = `${lines.join("\n")}\n`;
		writeFileSync(logPath, previous, "utf-8");

		const sizeBefore = readFileSync(logPath, "utf-8").length;
		expect(sizeBefore).toBeGreaterThan(1_024 * 1_024);

		// Append one more entry to trigger rotation
		await appendMemoryReviewLog(deskDir, {
			timestamp: "2026-04-19T00:00:00.000Z",
			channelId: "dingtalk:dm:123",
			reason: "reflect",
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
		const retained = rotatedContent.trim().split("\n");
		expect(retained.length).toBeGreaterThan(0);
		expect(retained.length).toBeLessThan(lines.length);
		expect(Buffer.byteLength(rotatedContent)).toBeLessThanOrEqual(1_024 * 1_024);
		expect(retained).toEqual(lines.slice(-retained.length));
	});
});
