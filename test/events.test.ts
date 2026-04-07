import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkBot, DingTalkEvent } from "../src/runtime/dingtalk.js";
import { EventsWatcher } from "../src/runtime/events.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-events-"));
	tempDirs.push(dir);
	return dir;
}

function getEventsWatcherPrivateApi(watcher: EventsWatcher): {
	parseEvent(content: string, filename: string): unknown;
	handleImmediate(filename: string, event: { type: "immediate"; channelId: string; text: string }): void;
	handleOneShot(filename: string, event: { type: "one-shot"; channelId: string; text: string; at: string }): void;
	handlePeriodic(
		filename: string,
		event: { type: "periodic"; channelId: string; text: string; schedule: string; timezone: string },
	): void;
	handleFile(filename: string): Promise<void>;
	sleep(ms: number): Promise<void>;
	execute(
		filename: string,
		event: {
			type: "immediate" | "one-shot" | "periodic";
			channelId: string;
			text: string;
			at?: string;
			schedule?: string;
		},
		deleteAfter?: boolean,
	): void;
} {
	return watcher as unknown as {
		parseEvent(content: string, filename: string): unknown;
		handleImmediate(filename: string, event: { type: "immediate"; channelId: string; text: string }): void;
		handleOneShot(filename: string, event: { type: "one-shot"; channelId: string; text: string; at: string }): void;
		handlePeriodic(
			filename: string,
			event: { type: "periodic"; channelId: string; text: string; schedule: string; timezone: string },
		): void;
		handleFile(filename: string): Promise<void>;
		sleep(ms: number): Promise<void>;
		execute(
			filename: string,
			event: {
				type: "immediate" | "one-shot" | "periodic";
				channelId: string;
				text: string;
				at?: string;
				schedule?: string;
			},
			deleteAfter?: boolean,
		): void;
	};
}

class FakeBot {
	public readonly events: DingTalkEvent[] = [];

	constructor(private readonly enqueueResult: boolean = true) {}

	enqueueEvent(event: DingTalkEvent): boolean {
		this.events.push(event);
		return this.enqueueResult;
	}
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("EventsWatcher", () => {
	it("parses valid event payloads and rejects invalid ones", () => {
		const watcher = new EventsWatcher(createTempDir(), new FakeBot() as unknown as DingTalkBot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		expect(
			privateApi.parseEvent(JSON.stringify({ type: "immediate", channelId: "dm_1", text: "hello" }), "a.json"),
		).toEqual({
			type: "immediate",
			channelId: "dm_1",
			text: "hello",
		});

		expect(() =>
			privateApi.parseEvent(JSON.stringify({ type: "periodic", channelId: "dm_1", text: "hello" }), "b.json"),
		).toThrow("Missing 'schedule' field");

		expect(() =>
			privateApi.parseEvent(JSON.stringify({ type: "unknown", channelId: "dm_1", text: "hello" }), "c.json"),
		).toThrow("Unknown event type");
	});

	it("deletes stale immediate events", () => {
		const dir = createTempDir();
		const filename = "stale.json";
		const filePath = join(dir, filename);
		writeFileSync(filePath, JSON.stringify({ type: "immediate", channelId: "dm_1", text: "hello" }));

		const beforeConstruct = new Date(Date.now() - 2000);
		const afterConstruct = new Date(Date.now() - 1000);
		const watcher = new EventsWatcher(dir, new FakeBot() as unknown as DingTalkBot);
		const privateApi = getEventsWatcherPrivateApi(watcher);
		vi.setSystemTime(new Date());
		utimesSync(filePath, beforeConstruct, afterConstruct);

		privateApi.handleImmediate(filename, { type: "immediate", channelId: "dm_1", text: "hello" });
		expect(existsSync(filePath)).toBe(false);
	});

	it("drops invalid and past one-shot events", () => {
		const dir = createTempDir();
		const watcher = new EventsWatcher(dir, new FakeBot() as unknown as DingTalkBot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		const invalidPath = join(dir, "invalid.json");
		writeFileSync(invalidPath, "{}");
		privateApi.handleOneShot("invalid.json", { type: "one-shot", channelId: "dm_1", text: "hello", at: "nope" });
		expect(existsSync(invalidPath)).toBe(true);
		expect(existsSync(join(dir, "invalid.json.error.txt"))).toBe(true);

		const pastPath = join(dir, "past.json");
		writeFileSync(pastPath, "{}");
		privateApi.handleOneShot("past.json", {
			type: "one-shot",
			channelId: "dm_1",
			text: "hello",
			at: "2020-01-01T00:00:00.000Z",
		});
		expect(existsSync(pastPath)).toBe(false);
	});

	it("schedules future one-shot events and rejects delays beyond platform limits", async () => {
		const dir = createTempDir();
		const watcher = new EventsWatcher(dir, new FakeBot() as unknown as DingTalkBot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		const futurePath = join(dir, "future.json");
		writeFileSync(futurePath, "{}");
		const bot = new FakeBot(true);
		const futureWatcher = new EventsWatcher(dir, bot as unknown as DingTalkBot);
		const futureApi = getEventsWatcherPrivateApi(futureWatcher);
		const futureAt = new Date(Date.now() + 5_000).toISOString();

		futureApi.handleOneShot("future.json", {
			type: "one-shot",
			channelId: "dm_future",
			text: "hello later",
			at: futureAt,
		});
		await vi.advanceTimersByTimeAsync(5_000);

		expect(bot.events).toHaveLength(1);
		expect(bot.events[0].text).toContain(`[EVENT:future.json:one-shot:${futureAt}] hello later`);
		expect(existsSync(futurePath)).toBe(false);

		const overflowPath = join(dir, "overflow.json");
		writeFileSync(overflowPath, "{}");
		privateApi.handleOneShot("overflow.json", {
			type: "one-shot",
			channelId: "dm_1",
			text: "too far",
			at: new Date(Date.now() + 2_147_483_648).toISOString(),
		});
		expect(existsSync(overflowPath)).toBe(true);
		expect(existsSync(join(dir, "overflow.json.error.txt"))).toBe(true);
	});

	it("preserves invalid periodic events and parse failures after retries", async () => {
		const dir = createTempDir();
		const watcher = new EventsWatcher(dir, new FakeBot() as unknown as DingTalkBot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		const invalidCronPath = join(dir, "invalid-cron.json");
		writeFileSync(invalidCronPath, "{}");
		privateApi.handlePeriodic("invalid-cron.json", {
			type: "periodic",
			channelId: "dm_1",
			text: "hello",
			schedule: "not a cron",
			timezone: "Asia/Shanghai",
		});
		expect(existsSync(invalidCronPath)).toBe(true);
		expect(existsSync(join(dir, "invalid-cron.json.error.txt"))).toBe(true);

		const brokenPath = join(dir, "broken.json");
		writeFileSync(brokenPath, "{");
		vi.spyOn(privateApi, "sleep").mockResolvedValue(undefined);
		const pending = privateApi.handleFile("broken.json");
		await pending;
		expect(existsSync(brokenPath)).toBe(true);
		expect(existsSync(join(dir, "broken.json.error.txt"))).toBe(true);
	});

	it("enqueues synthetic events and deletes handled files", () => {
		const dir = createTempDir();
		const filename = "periodic.json";
		const filePath = join(dir, filename);
		writeFileSync(filePath, "{}");
		const bot = new FakeBot(true);
		const watcher = new EventsWatcher(dir, bot as unknown as DingTalkBot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		privateApi.execute(
			filename,
			{
				type: "periodic",
				channelId: "dm_42",
				text: "run maintenance",
				schedule: "0 3 * * 0",
			},
			true,
		);

		expect(bot.events).toHaveLength(1);
		expect(bot.events[0]).toMatchObject({
			channelId: "dm_42",
			user: "EVENT",
			text: "[EVENT:periodic.json:periodic:0 3 * * 0] run maintenance",
		});
		expect(existsSync(filePath)).toBe(false);
	});

	it("keeps periodic event files when they are re-queued without deletion", () => {
		const dir = createTempDir();
		const filename = "keep.json";
		const filePath = join(dir, filename);
		writeFileSync(filePath, "{}");
		const bot = new FakeBot(true);
		const watcher = new EventsWatcher(dir, bot as unknown as DingTalkBot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		privateApi.execute(
			filename,
			{
				type: "periodic",
				channelId: "dm_7",
				text: "keep file",
				schedule: "0 3 * * 0",
			},
			false,
		);

		expect(bot.events).toHaveLength(1);
		expect(existsSync(filePath)).toBe(true);
		expect(statSync(filePath).isFile()).toBe(true);
	});
});
