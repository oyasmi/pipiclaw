import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMemoryReviewLog } from "../src/memory/review-log.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-review-log-");

function createChannelDir(): string {
	return join(createTempDir(), "dm_123");
}

describe("memory review log", () => {
	it("serializes concurrent appends without corrupting JSONL", async () => {
		const channelDir = createChannelDir();

		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				appendMemoryReviewLog(channelDir, {
					timestamp: `2026-04-19T00:00:0${index}.000Z`,
					channelId: "dm_123",
					reason: "reflect",
					actions: [{ index }],
				}),
			),
		);

		const lines = readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(8);
		const entries = lines.map((line) => JSON.parse(line) as { timestamp: string; actions: Array<{ index: number }> });
		expect(entries.map((entry) => entry.actions[0]?.index).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(new Set(entries.map((entry) => entry.timestamp)).size).toBe(8);
	});

	it("deduplicates consecutive identical gate skips", async () => {
		const channelDir = createChannelDir();
		const base = {
			channelId: "dm_123",
			reason: "reflect" as const,
			skipped: [{ target: "reflect", reason: "clean" }],
		};
		await appendMemoryReviewLog(channelDir, { ...base, timestamp: "2026-04-19T00:00:00.000Z" });
		await appendMemoryReviewLog(channelDir, { ...base, timestamp: "2026-04-19T00:01:00.000Z" });
		const lines = readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
	});
});
