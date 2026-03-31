import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelStore, type LoggedSubAgentRun } from "../src/store.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-store-"));
	tempDirs.push(dir);
	return dir;
}

function sampleSubAgentRun(): LoggedSubAgentRun {
	return {
		date: "2026-04-01T00:00:00.000Z",
		toolCallId: "call-1",
		label: "Investigate",
		agent: "reviewer",
		source: "predefined",
		model: "anthropic/claude-sonnet-4",
		tools: ["read", "bash"],
		turns: 2,
		toolCalls: 1,
		durationMs: 500,
		failed: false,
		output: "Done",
		outputTruncated: false,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			total: 15,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.003,
			},
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ChannelStore", () => {
	it("deduplicates recent messages, fills missing dates, and expires the dedupe window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-01T08:00:00.000Z"));

		const store = new ChannelStore({ workingDir: createTempDir() });
		const channelId = "dm_1";
		const first = await store.logMessage(channelId, {
			date: "",
			ts: "100",
			user: "alice",
			text: "hello",
			isBot: false,
		});
		const duplicate = await store.logMessage(channelId, {
			ts: "100",
			date: "2026-04-01T08:00:01.000Z",
			user: "alice",
			text: "hello again",
			isBot: false,
		});

		expect(first).toBe(true);
		expect(duplicate).toBe(false);

		const logPath = join(store.getChannelDir(channelId), "log.jsonl");
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({
			ts: "100",
			user: "alice",
			text: "hello",
			isBot: false,
			date: "2026-04-01T08:00:00.000Z",
		});

		await vi.advanceTimersByTimeAsync(60_001);
		const afterExpiry = await store.logMessage(channelId, {
			ts: "100",
			date: "2026-04-01T08:01:01.000Z",
			user: "alice",
			text: "hello after timeout",
			isBot: false,
		});
		expect(afterExpiry).toBe(true);
	});

	it("rotates oversized logs, resets sync offsets, and writes subagent runs", async () => {
		const store = new ChannelStore({ workingDir: createTempDir() });
		const channelDir = store.getChannelDir("dm_rotate");
		const logPath = join(channelDir, "log.jsonl");
		const syncOffsetPath = join(channelDir, ".sync-offset");

		writeFileSync(logPath, "x".repeat(1_000_001), "utf-8");
		writeFileSync(syncOffsetPath, "42", "utf-8");

		await store.logMessage("dm_rotate", {
			date: "2026-04-01T10:00:00.000Z",
			ts: "200",
			user: "alice",
			text: "rotated",
			isBot: false,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(existsSync(`${logPath}.1`)).toBe(true);
		expect(readFileSync(syncOffsetPath, "utf-8")).toBe("0");
		expect(readFileSync(logPath, "utf-8")).toContain('"text":"rotated"');

		await store.logSubAgentRun("dm_rotate", sampleSubAgentRun());
		expect(readFileSync(join(channelDir, "subagent-runs.jsonl"), "utf-8")).toContain('"toolCallId":"call-1"');
	});

	it("returns the last logged timestamp and handles invalid or empty logs", async () => {
		const store = new ChannelStore({ workingDir: createTempDir() });
		const channelDir = store.getChannelDir("dm_last");
		const logPath = join(channelDir, "log.jsonl");

		writeFileSync(
			logPath,
			[
				'{"date":"2026-04-01T10:00:00.000Z","ts":"1","user":"alice","text":"a","isBot":false}',
				'{"date":"2026-04-01T10:01:00.000Z","ts":"2","user":"alice","text":"b","isBot":false}\r',
				"",
				"",
			].join("\n"),
			"utf-8",
		);
		expect(store.getLastTimestamp("dm_last")).toBe("2");

		writeFileSync(join(store.getChannelDir("dm_empty"), "log.jsonl"), "", "utf-8");
		expect(store.getLastTimestamp("dm_empty")).toBeNull();

		writeFileSync(join(store.getChannelDir("dm_invalid"), "log.jsonl"), "{broken}\n", "utf-8");
		expect(store.getLastTimestamp("dm_invalid")).toBeNull();

		await store.logBotResponse("dm_bot", "hello", "300");
		expect(store.getLastTimestamp("dm_bot")).toBe("300");
	});
});
