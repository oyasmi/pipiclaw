import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelStore, type LoggedSubAgentRun } from "../src/channel/store.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-store-");

/** Every channel but `dm_unbound` archives into its own conversation directory under `root`. */
function storeFor(root: string): ChannelStore {
	return new ChannelStore({
		resolveArchiveDir: (channelId) => (channelId === "dm_unbound" ? undefined : join(root, channelId)),
	});
}

/** The store resolves archive paths without creating them, so a test that seeds a file says so. */
function seedChannelDir(workingDir: string, channelId: string): string {
	const dotDir = join(workingDir, channelId);
	mkdirSync(dotDir, { recursive: true });
	return dotDir;
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
});

describe("ChannelStore", () => {
	it("deduplicates recent messages, fills missing dates, and expires the dedupe window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-01T08:00:00.000Z"));

		const workingDir = createTempDir();
		const store = storeFor(workingDir);
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
		expect((store as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer).not.toBeNull();

		const logPath = join(workingDir, channelId, "log.jsonl");
		await store.flush();
		const lines = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject({
			ts: "100",
			user: "alice",
			text: "hello",
			isBot: false,
			date: "2026-04-01T16:00:00.000+08:00",
		});

		await vi.advanceTimersByTimeAsync(60_001);
		expect((store as unknown as { cleanupTimer: NodeJS.Timeout | null }).cleanupTimer).toBeNull();
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
		const workingDir = createTempDir();
		const store = storeFor(workingDir);
		const dotDir = seedChannelDir(workingDir, "dm_rotate");
		const logPath = join(dotDir, "log.jsonl");
		const syncOffsetPath = join(dotDir, ".sync-offset");

		writeFileSync(logPath, "x".repeat(1_000_001), "utf-8");
		writeFileSync(syncOffsetPath, "42", "utf-8");

		await store.logMessage("dm_rotate", {
			date: "2026-04-01T10:00:00.000Z",
			ts: "200",
			user: "alice",
			text: "rotated",
			isBot: false,
		});
		await store.flush();

		expect(existsSync(`${logPath}.1`)).toBe(true);
		expect(readFileSync(syncOffsetPath, "utf-8")).toBe("0");
		expect(readFileSync(logPath, "utf-8")).toContain('"text":"rotated"');

		await store.logSubAgentRun(dotDir, sampleSubAgentRun());
		await store.flush();
		expect(readFileSync(join(dotDir, "subagent-runs.jsonl"), "utf-8")).toContain('"toolCallId":"call-1"');
	});

	it("serializes concurrent writes to the same log file around rotation", async () => {
		const workingDir = createTempDir();
		const store = storeFor(workingDir);
		const dotDir = seedChannelDir(workingDir, "dm_concurrent");
		const logPath = join(dotDir, "log.jsonl");

		writeFileSync(logPath, "x".repeat(1_000_001), "utf-8");

		const [first, second] = await Promise.all([
			store.logMessage("dm_concurrent", {
				date: "2026-04-01T10:00:00.000Z",
				ts: "201",
				user: "alice",
				text: "first",
				isBot: false,
			}),
			store.logMessage("dm_concurrent", {
				date: "2026-04-01T10:00:01.000Z",
				ts: "202",
				user: "alice",
				text: "second",
				isBot: false,
			}),
		]);
		await store.flush();

		expect(first).toBe(true);
		expect(second).toBe(true);
		expect(existsSync(`${logPath}.1`)).toBe(true);
		expect(readFileSync(logPath, "utf-8")).toContain('"text":"first"');
		expect(readFileSync(logPath, "utf-8")).toContain('"text":"second"');
	});

	it("archives nothing for a channel that is not bound to a dot", async () => {
		// Spec 058, D4: an unbound channel leaves no trace on disk — no directory, no log.
		const workingDir = createTempDir();
		const store = storeFor(workingDir);

		const logged = await store.logMessage("dm_unbound", {
			date: "2026-04-01T10:00:00.000Z",
			ts: "400",
			user: "alice",
			text: "hello",
			isBot: false,
		});
		await store.flush();

		expect(logged).toBe(false);
		expect(readdirSync(workingDir)).toEqual([]);
	});
});
