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
	it("appends JSONL entries and creates the channel directory", async () => {
		const channelDir = createChannelDir();

		await appendMemoryReviewLog(channelDir, {
			timestamp: "2026-04-19T00:00:00.000Z",
			channelId: "dm_123",
			reason: "idle",
			skipped: [{ target: "HISTORY.md" }],
		});
		await appendMemoryReviewLog(channelDir, {
			timestamp: "2026-04-19T00:01:00.000Z",
			channelId: "dm_123",
			reason: "memory-checkpoint-job",
			actions: [{ target: "MEMORY.md" }],
		});

		const lines = readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]!).reason).toBe("idle");
		expect(JSON.parse(lines[1]!).actions[0].target).toBe("MEMORY.md");
	});

	it("serializes concurrent appends without corrupting JSONL", async () => {
		const channelDir = createChannelDir();

		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				appendMemoryReviewLog(channelDir, {
					timestamp: `2026-04-19T00:00:0${index}.000Z`,
					channelId: "dm_123",
					reason: "memory-checkpoint-job",
					actions: [{ index }],
				}),
			),
		);

		const lines = readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(8);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it("deduplicates consecutive identical gate skips", async () => {
		const channelDir = createChannelDir();
		const base = {
			channelId: "dm_123",
			reason: "memory-checkpoint-job" as const,
			skipped: [{ target: "consolidation", reason: "clean" }],
		};
		await appendMemoryReviewLog(channelDir, { ...base, timestamp: "2026-04-19T00:00:00.000Z" });
		await appendMemoryReviewLog(channelDir, { ...base, timestamp: "2026-04-19T00:01:00.000Z" });
		const lines = readFileSync(join(channelDir, "memory-review.jsonl"), "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
	});
});
