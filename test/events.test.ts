import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/executor.js";
import type { DingTalkBot, DingTalkEvent } from "../src/runtime/dingtalk.js";
import { DurableDispatchService } from "../src/runtime/durable-dispatch.js";
import type { EventAction } from "../src/runtime/events.js";
import { EventsWatcher } from "../src/runtime/events.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-events-");

function getEventsWatcherPrivateApi(watcher: EventsWatcher): {
	parseEvent(content: string, filename: string): unknown;
	handleOneShot(
		filename: string,
		event: { type: "one-shot"; channelId: string; text: string; at: string },
	): Promise<void>;
	handlePeriodic(
		filename: string,
		event: { type: "periodic"; channelId: string; text: string; schedule: string; timezone: string },
	): void;
	handleFile(filename: string): Promise<void>;
	sleep(ms: number): Promise<void>;
	execute(
		filename: string,
		event: {
			type: "one-shot" | "periodic";
			channelId: string;
			text: string;
			at?: string;
			schedule?: string;
			preAction?: EventAction;
		},
		deleteAfter?: boolean,
		occurrence?: Date,
	): Promise<void>;
	runPreAction(action: EventAction, filename: string): Promise<void>;
} {
	return watcher as unknown as {
		parseEvent(content: string, filename: string): unknown;
		handleOneShot(
			filename: string,
			event: { type: "one-shot"; channelId: string; text: string; at: string },
		): Promise<void>;
		handlePeriodic(
			filename: string,
			event: { type: "periodic"; channelId: string; text: string; schedule: string; timezone: string },
		): void;
		handleFile(filename: string): Promise<void>;
		sleep(ms: number): Promise<void>;
		execute(
			filename: string,
			event: {
				type: "one-shot" | "periodic";
				channelId: string;
				text: string;
				at?: string;
				schedule?: string;
				preAction?: EventAction;
			},
			deleteAfter?: boolean,
		): Promise<void>;
		runPreAction(action: EventAction, filename: string): Promise<void>;
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

function createMockExecutor(execImpl?: (command: string, options?: ExecOptions) => Promise<ExecResult>): Executor {
	return {
		exec:
			execImpl ??
			(async (command: string, options?: ExecOptions): Promise<ExecResult> => {
				switch (command) {
					case "true":
						return { stdout: "", stderr: "", code: 0 };
					case "false":
						return { stdout: "", stderr: "", code: 1 };
					case "sleep 30":
						if ((options?.timeout ?? Number.POSITIVE_INFINITY) < 30) {
							throw new Error(`Command timed out after ${options?.timeout} seconds`);
						}
						return { stdout: "", stderr: "", code: 0 };
					case "/nonexistent/binary/xyz":
						throw new Error("spawn ENOENT");
					default:
						return { stdout: "", stderr: "", code: 0 };
				}
			}),
	};
}

function createWatcher(
	dir: string,
	bot: FakeBot = new FakeBot(),
	executor: Executor = createMockExecutor(),
	guardConfig?: {
		enabled: boolean;
		additionalDenyPatterns: string[];
		allowPatterns: string[];
		blockObfuscation: boolean;
	},
	historyPath?: string,
): EventsWatcher {
	return new EventsWatcher(dir, bot as unknown as DingTalkBot, executor, guardConfig, { historyPath });
}

function readHistory(historyPath: string): Array<Record<string, unknown>> {
	const content = readFileSync(historyPath, "utf-8").trim();
	return content ? content.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>) : [];
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("EventsWatcher", () => {
	it("parses valid event payloads and rejects invalid ones", () => {
		const watcher = createWatcher(createTempDir());
		const privateApi = getEventsWatcherPrivateApi(watcher);

		// Immediate events are rejected at the parse boundary itself (spec 031, D4), so no
		// hand-written file can re-introduce a self-triggering wake.
		expect(() =>
			privateApi.parseEvent(JSON.stringify({ type: "immediate", channelId: "dm_1", text: "hello" }), "a.json"),
		).toThrow("Immediate events are no longer supported");

		expect(() =>
			privateApi.parseEvent(JSON.stringify({ type: "periodic", channelId: "dm_1", text: "hello" }), "b.json"),
		).toThrow("Missing 'schedule' field");

		expect(() =>
			privateApi.parseEvent(JSON.stringify({ type: "unknown", channelId: "dm_1", text: "hello" }), "c.json"),
		).toThrow("Unknown event type");
	});

	it("initializes an empty event history file on start", () => {
		const dir = createTempDir();
		const historyPath = join(createTempDir(), "state", "events", "history.jsonl");
		const watcher = createWatcher(dir, new FakeBot(), createMockExecutor(), undefined, historyPath);

		watcher.start();
		watcher.stop();

		expect(existsSync(historyPath)).toBe(true);
		expect(readFileSync(historyPath, "utf-8")).toBe("");
	});

	it("refuses to schedule a hand-written immediate event (spec 031, D4)", async () => {
		const dir = createTempDir();
		const historyPath = join(createTempDir(), "history.jsonl");
		const filename = "loop.json";
		writeFileSync(join(dir, filename), JSON.stringify({ type: "immediate", channelId: "dm_1", text: "again" }));
		const bot = new FakeBot(true);
		const watcher = createWatcher(dir, bot, createMockExecutor(), undefined, historyPath);
		const privateApi = getEventsWatcherPrivateApi(watcher);
		vi.spyOn(privateApi, "sleep").mockResolvedValue(undefined);

		await privateApi.handleFile(filename);
		await watcher.flush();

		expect(bot.events).toHaveLength(0);
		expect(readFileSync(join(dir, `${filename}.error.txt`), "utf-8")).toContain(
			"Immediate events are no longer supported",
		);
		expect(readHistory(historyPath)).toEqual([
			expect.objectContaining({ eventName: "loop", action: "invalid", result: "error" }),
		]);
	});

	it("marks invalid one-shots and recovers past one-shots once", async () => {
		const dir = createTempDir();
		const bot = new FakeBot();
		const watcher = createWatcher(dir, bot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		const invalidPath = join(dir, "invalid.json");
		writeFileSync(invalidPath, "{}");
		await privateApi.handleOneShot("invalid.json", {
			type: "one-shot",
			channelId: "dm_1",
			text: "hello",
			at: "nope",
		});
		expect(existsSync(invalidPath)).toBe(true);
		expect(existsSync(join(dir, "invalid.json.error.txt"))).toBe(true);

		const pastPath = join(dir, "past.json");
		writeFileSync(pastPath, "{}");
		await privateApi.handleOneShot("past.json", {
			type: "one-shot",
			channelId: "dm_1",
			text: "hello",
			at: "2020-01-01T00:00:00.000Z",
		});
		expect(existsSync(pastPath)).toBe(false);
		expect(bot.events).toHaveLength(1);
	});

	it("schedules future one-shot events and rejects delays beyond platform limits", async () => {
		const dir = createTempDir();
		const watcher = createWatcher(dir);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		const futurePath = join(dir, "future.json");
		writeFileSync(futurePath, "{}");
		const bot = new FakeBot(true);
		const futureWatcher = createWatcher(dir, bot);
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
		const watcher = createWatcher(dir);
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

	it("enqueues synthetic events and deletes handled files", async () => {
		const dir = createTempDir();
		const historyPath = join(createTempDir(), "history.jsonl");
		const filename = "periodic.json";
		const filePath = join(dir, filename);
		writeFileSync(filePath, "{}");
		const bot = new FakeBot(true);
		const watcher = createWatcher(dir, bot, createMockExecutor(), undefined, historyPath);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		await privateApi.execute(
			filename,
			{
				type: "periodic",
				channelId: "dm_42",
				text: "run maintenance",
				schedule: "0 3 * * 0",
			},
			true,
		);
		await watcher.flush();

		expect(bot.events).toHaveLength(1);
		expect(bot.events[0]).toMatchObject({
			channelId: "dm_42",
			user: "EVENT",
			// Periodic wakes carry the [SILENT] contract in their trigger, not the system prompt (spec 026 §7.3).
			text: "[EVENT:periodic.json:periodic:0 3 * * 0] run maintenance This is a periodic runtime wake. If it produces no user-visible change or result, reply with exactly [SILENT].",
		});
		expect(existsSync(filePath)).toBe(false);

		const history = readHistory(historyPath);
		expect(history.some((entry) => entry.action === "enqueued" && entry.result === "ok")).toBe(true);
		expect(history.some((entry) => entry.action === "deleted" && entry.result === "ok")).toBe(true);
		expect(history[0]?.ts).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/));
		expect(String(history[0]?.ts)).not.toContain("Z");
	});

	it("does not append the periodic silence contract to one-shot events", async () => {
		const dir = createTempDir();
		const filename = "reminder.json";
		writeFileSync(join(dir, filename), "{}");
		const bot = new FakeBot(true);
		const watcher = createWatcher(dir, bot, createMockExecutor());
		const privateApi = getEventsWatcherPrivateApi(watcher);

		await privateApi.execute(
			filename,
			{ type: "one-shot", channelId: "dm_9", text: "ping the user", at: "2026-07-20T09:00:00+08:00" },
			true,
		);

		expect(bot.events).toHaveLength(1);
		expect(bot.events[0]?.text).toBe("[EVENT:reminder.json:one-shot:2026-07-20T09:00:00+08:00] ping the user");
		expect(bot.events[0]?.text).not.toContain("[SILENT]");
	});

	describe("admission gate (spec 031, D4)", () => {
		it("rejects a hand-written near-term one-shot that the tool would have refused", async () => {
			const dir = createTempDir();
			const filename = "self-trigger.json";
			const filePath = join(dir, filename);
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot, createMockExecutor());
			const privateApi = getEventsWatcherPrivateApi(watcher);
			writeFileSync(
				filePath,
				JSON.stringify({
					type: "one-shot",
					channelId: "dm_1",
					text: "wake me right now",
					at: new Date(Date.now() + 5_000).toISOString(),
				}),
			);
			// Written while this process was running → held to the lead time.
			const afterStart = new Date(Date.now() + 60_000);
			utimesSync(filePath, afterStart, afterStart);
			vi.spyOn(privateApi, "sleep").mockResolvedValue(undefined);

			await privateApi.handleFile(filename);

			expect(bot.events).toHaveLength(0);
			expect(readFileSync(`${filePath}.error.txt`, "utf-8")).toContain("at least 2 minutes in the future");
		});

		it("still recovers a past one-shot that predates this process", async () => {
			const dir = createTempDir();
			const filename = "missed.json";
			const filePath = join(dir, filename);
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot, createMockExecutor());
			const privateApi = getEventsWatcherPrivateApi(watcher);
			writeFileSync(
				filePath,
				JSON.stringify({
					type: "one-shot",
					channelId: "dm_1",
					text: "missed while down",
					at: new Date(Date.now() - 60_000).toISOString(),
				}),
			);
			// Predates startup → a legitimate recovery, not a self-trigger, so the lead time
			// must not apply or a restart would silently discard missed work.
			const beforeStart = new Date(Date.now() - 60_000);
			utimesSync(filePath, beforeStart, beforeStart);
			vi.spyOn(privateApi, "sleep").mockResolvedValue(undefined);

			await privateApi.handleFile(filename);

			expect(bot.events).toHaveLength(1);
			expect(existsSync(`${filePath}.error.txt`)).toBe(false);
		});

		it("rejects a hand-written high-frequency periodic", async () => {
			const dir = createTempDir();
			const filename = "hot.json";
			const filePath = join(dir, filename);
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot, createMockExecutor());
			const privateApi = getEventsWatcherPrivateApi(watcher);
			writeFileSync(
				filePath,
				JSON.stringify({ type: "periodic", channelId: "dm_1", text: "burn tokens", schedule: "* * * * *" }),
			);
			vi.spyOn(privateApi, "sleep").mockResolvedValue(undefined);

			await privateApi.handleFile(filename);

			expect(bot.events).toHaveLength(0);
			expect(readFileSync(`${filePath}.error.txt`, "utf-8")).toContain("no more often than every 30 minutes");
		});
	});

	describe("orphaned task-owned events (spec 031, D5)", () => {
		/** The watcher resolves `<workspace>/<channelId>/tasks/<id>.md` relative to its events dir. */
		function writeOwningTask(eventsDir: string, channelId: string, taskId: string, status: string): void {
			const tasksDir = join(dirname(eventsDir), channelId, "tasks");
			mkdirSync(tasksDir, { recursive: true });
			writeFileSync(join(tasksDir, `${taskId}.md`), `---\nstatus: ${status}\n---\n# Task\n`);
		}

		function taskEventFixture(channelId: string) {
			return { type: "periodic" as const, channelId, text: "check the task", schedule: "0 * * * *" };
		}

		it("fires while the owning task is still live", async () => {
			const dir = join(createTempDir(), "events");
			mkdirSync(dir, { recursive: true });
			writeOwningTask(dir, "dm_1", "report", "active");
			const filename = "task.dm_1.report.checkin.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const privateApi = getEventsWatcherPrivateApi(createWatcher(dir, bot, createMockExecutor()));

			await privateApi.execute(filename, taskEventFixture("dm_1"), false);

			expect(bot.events).toHaveLength(1);
			expect(existsSync(join(dir, filename))).toBe(true);
		});

		it("retires itself when the owning task is gone", async () => {
			const dir = join(createTempDir(), "events");
			mkdirSync(dir, { recursive: true });
			const filename = "task.dm_1.report.checkin.json";
			writeFileSync(join(dir, filename), "{}");
			const historyPath = join(createTempDir(), "history.jsonl");
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot, createMockExecutor(), undefined, historyPath);

			await getEventsWatcherPrivateApi(watcher).execute(filename, taskEventFixture("dm_1"), false);
			await watcher.flush();

			expect(bot.events).toHaveLength(0);
			expect(existsSync(join(dir, filename))).toBe(false);
			expect(readHistory(historyPath)).toContainEqual(
				expect.objectContaining({ action: "skipped", reason: "owning task report no longer exists" }),
			);
		});

		it("retires itself when the owning task reached a terminal status", async () => {
			const dir = join(createTempDir(), "events");
			mkdirSync(dir, { recursive: true });
			writeOwningTask(dir, "dm_1", "report", "cancelled");
			const filename = "task.dm_1.report.checkin.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const privateApi = getEventsWatcherPrivateApi(createWatcher(dir, bot, createMockExecutor()));

			await privateApi.execute(filename, taskEventFixture("dm_1"), false);

			expect(bot.events).toHaveLength(0);
			expect(existsSync(join(dir, filename))).toBe(false);
		});

		it("parses the task id correctly when the channel id contains dots", async () => {
			const dir = join(createTempDir(), "events");
			mkdirSync(dir, { recursive: true });
			writeOwningTask(dir, "dm_a.b.c", "report", "active");
			const filename = "task.dm_a.b.c.report.checkin.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const privateApi = getEventsWatcherPrivateApi(createWatcher(dir, bot, createMockExecutor()));

			await privateApi.execute(filename, taskEventFixture("dm_a.b.c"), false);

			expect(bot.events).toHaveLength(1);
		});
	});

	describe("stable dispatch ids (spec 031, D1)", () => {
		it("keys a one-shot on its own `at`, so re-execution reuses the same identity", async () => {
			const dir = createTempDir();
			const filename = "reminder.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const privateApi = getEventsWatcherPrivateApi(createWatcher(dir, bot, createMockExecutor()));
			const definition = {
				type: "one-shot" as const,
				channelId: "dm_9",
				text: "ping",
				at: "2026-07-20T09:00:00+08:00",
			};

			await privateApi.execute(filename, definition, false);
			await privateApi.execute(filename, definition, false);

			expect(bot.events[0]?.dispatchId).toBe("event:reminder:2026-07-20T09:00:00+08:00");
			expect(bot.events[1]?.dispatchId).toBe(bot.events[0]?.dispatchId);
		});

		it("keys a periodic on the occurrence, so occurrences stay distinct", async () => {
			const dir = createTempDir();
			const filename = "sweep.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const privateApi = getEventsWatcherPrivateApi(createWatcher(dir, bot, createMockExecutor()));
			const definition = { type: "periodic" as const, channelId: "dm_9", text: "sweep", schedule: "0 * * * *" };

			await privateApi.execute(filename, definition, false, new Date("2026-07-20T09:00:00Z"));
			await privateApi.execute(filename, definition, false, new Date("2026-07-20T10:00:00Z"));

			expect(bot.events[0]?.dispatchId).toBe("event:sweep:2026-07-20T09:00:00.000Z");
			expect(bot.events[1]?.dispatchId).toBe("event:sweep:2026-07-20T10:00:00.000Z");
		});

		it("delivers one occurrence once across both the outbox retry and restart recovery paths", async () => {
			const dir = createTempDir();
			const stateDir = join(createTempDir(), "dispatch");
			const delivered: DingTalkEvent[] = [];
			let accept = false;
			const service = new DurableDispatchService({
				stateDir,
				bot: {
					enqueueEvent(next) {
						if (!accept) return false;
						delivered.push(next);
						return true;
					},
				},
			});
			const filename = "reminder.json";
			writeFileSync(join(dir, filename), "{}");
			const watcher = new EventsWatcher(
				dir,
				new FakeBot() as unknown as DingTalkBot,
				createMockExecutor(),
				undefined,
				{ dispatch: (event) => service.dispatch(event) },
			);
			const privateApi = getEventsWatcherPrivateApi(watcher);
			const definition = {
				type: "one-shot" as const,
				channelId: "dm_1",
				text: "check",
				at: "2026-07-20T10:00:00+08:00",
			};

			// Channel queue full: the occurrence is persisted rather than delivered.
			await privateApi.execute(filename, definition, true);
			expect(delivered).toHaveLength(0);
			expect(readdirSync(stateDir)).toHaveLength(1);

			// A restart re-executes the surviving file; the same occurrence must not become a
			// second record, or the file-recovery and outbox paths would each deliver it.
			await privateApi.execute(filename, definition, true);
			expect(readdirSync(stateDir)).toHaveLength(1);

			accept = true;
			await service.drainOnce();
			expect(delivered).toHaveLength(1);
		});
	});

	it("records invalid event parse failures in history", async () => {
		const dir = createTempDir();
		const historyPath = join(createTempDir(), "history.jsonl");
		const watcher = createWatcher(dir, new FakeBot(), createMockExecutor(), undefined, historyPath);
		const privateApi = getEventsWatcherPrivateApi(watcher);
		const brokenPath = join(dir, "broken.json");
		writeFileSync(brokenPath, "{");
		vi.spyOn(privateApi, "sleep").mockResolvedValue(undefined);

		await privateApi.handleFile("broken.json");
		await watcher.flush();

		expect(readHistory(historyPath)).toEqual([
			expect.objectContaining({
				eventName: "broken",
				eventType: "unknown",
				action: "invalid",
				result: "error",
			}),
		]);
	});

	it("keeps periodic event files when they are re-queued without deletion", async () => {
		const dir = createTempDir();
		const filename = "keep.json";
		const filePath = join(dir, filename);
		writeFileSync(filePath, "{}");
		const bot = new FakeBot(true);
		const watcher = createWatcher(dir, bot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		await privateApi.execute(
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

	it("preserves a one-shot event and writes an error marker when the queue is full", async () => {
		const dir = createTempDir();
		const filename = "dropped.json";
		const filePath = join(dir, filename);
		writeFileSync(filePath, "{}");
		const bot = new FakeBot(false);
		const watcher = createWatcher(dir, bot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		await privateApi.execute(
			filename,
			{ type: "one-shot", channelId: "dm_1", text: "must not vanish", at: "2030-01-01T00:00:00.000Z" },
			true,
		);

		// File survives and the loss is recorded rather than silently dropped.
		expect(existsSync(filePath)).toBe(true);
		expect(existsSync(join(dir, "dropped.json.error.txt"))).toBe(true);
	});

	it("does not mark periodic events invalid on a transient full queue", async () => {
		const dir = createTempDir();
		const filename = "recurring.json";
		const filePath = join(dir, filename);
		writeFileSync(filePath, "{}");
		const bot = new FakeBot(false);
		const watcher = createWatcher(dir, bot);
		const privateApi = getEventsWatcherPrivateApi(watcher);

		await privateApi.execute(
			filename,
			{ type: "periodic", channelId: "dm_1", text: "tick", schedule: "0 3 * * 0" },
			false,
		);

		expect(existsSync(filePath)).toBe(true);
		expect(existsSync(join(dir, "recurring.json.error.txt"))).toBe(false);
	});

	describe("action gate", () => {
		it("enqueues event when action exits with code 0", async () => {
			const dir = createTempDir();
			const filename = "gated.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			await privateApi.execute(
				filename,
				{
					type: "one-shot",
					at: "2030-01-01T00:00:00.000Z",
					channelId: "dm_1",
					text: "should pass",
					preAction: { type: "bash", command: "true" },
				},
				false,
			);

			expect(bot.events).toHaveLength(1);
			expect(bot.events[0].text).toContain("should pass");
		});

		it("blocks event when action exits with non-zero code", async () => {
			const dir = createTempDir();
			const historyPath = join(createTempDir(), "history.jsonl");
			const filename = "blocked.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot, createMockExecutor(), undefined, historyPath);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			await privateApi.execute(
				filename,
				{
					type: "one-shot",
					at: "2030-01-01T00:00:00.000Z",
					channelId: "dm_1",
					text: "should not pass",
					preAction: { type: "bash", command: "false" },
				},
				false,
			);
			await watcher.flush();

			expect(bot.events).toHaveLength(0);
			expect(readHistory(historyPath)).toEqual([
				expect.objectContaining({ action: "pre_action_started", result: "ok" }),
				expect.objectContaining({
					action: "pre_action_blocked",
					result: "skipped",
					reason: "exit 1",
					preAction: expect.objectContaining({ command: "false", exitCode: 1 }),
				}),
			]);
		});

		it("blocks event when action times out", async () => {
			const dir = createTempDir();
			const filename = "timeout.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			await privateApi.execute(
				filename,
				{
					type: "one-shot",
					at: "2030-01-01T00:00:00.000Z",
					channelId: "dm_1",
					text: "should timeout",
					preAction: { type: "bash", command: "sleep 30", timeout: 100 },
				},
				false,
			);

			expect(bot.events).toHaveLength(0);
		});

		it("blocks event when action command does not exist", async () => {
			const dir = createTempDir();
			const filename = "noexist.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			await privateApi.execute(
				filename,
				{
					type: "one-shot",
					at: "2030-01-01T00:00:00.000Z",
					channelId: "dm_1",
					text: "bad command",
					preAction: { type: "bash", command: "/nonexistent/binary/xyz" },
				},
				false,
			);

			expect(bot.events).toHaveLength(0);
		});

		it("enqueues event normally when no action is specified (regression)", async () => {
			const dir = createTempDir();
			const filename = "noaction.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const watcher = createWatcher(dir, bot);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			await privateApi.execute(
				filename,
				{
					type: "one-shot",
					at: "2030-01-01T00:00:00.000Z",
					channelId: "dm_1",
					text: "no action",
				},
				false,
			);

			expect(bot.events).toHaveLength(1);
			expect(bot.events[0].text).toContain("no action");
		});

		it("blocks event when guardCommand rejects the command", async () => {
			const dir = createTempDir();
			const filename = "guarded.json";
			writeFileSync(join(dir, filename), "{}");
			const bot = new FakeBot(true);
			const guardConfig = {
				enabled: true,
				additionalDenyPatterns: [] as string[],
				allowPatterns: [] as string[],
				blockObfuscation: true,
			};
			const watcher = createWatcher(dir, bot, createMockExecutor(), guardConfig);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			await privateApi.execute(
				filename,
				{
					type: "one-shot",
					at: "2030-01-01T00:00:00.000Z",
					channelId: "dm_1",
					text: "dangerous",
					preAction: { type: "bash", command: "rm -rf /" },
				},
				false,
			);

			expect(bot.events).toHaveLength(0);
		});

		it("converts action timeout from milliseconds to executor seconds", async () => {
			const execSpy = vi.fn(
				async (_command: string, _options?: ExecOptions): Promise<ExecResult> => ({
					stdout: "",
					stderr: "",
					code: 0,
				}),
			);
			const watcher = createWatcher(createTempDir(), new FakeBot(), createMockExecutor(execSpy));
			const privateApi = getEventsWatcherPrivateApi(watcher);

			await privateApi.runPreAction({ type: "bash", command: "true", timeout: 100 }, "timeout-ms.json");

			expect(execSpy).toHaveBeenCalledWith("true", { timeout: 1 });
		});

		it("rejects action with empty command in parseEvent", () => {
			const dir = createTempDir();
			const watcher = createWatcher(dir);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			expect(() =>
				privateApi.parseEvent(
					JSON.stringify({
						type: "one-shot",
						at: "2030-01-01T00:00:00.000Z",
						channelId: "dm_1",
						text: "hello",
						preAction: { type: "bash", command: "" },
					}),
					"empty-cmd.json",
				),
			).toThrow("Missing or empty 'preAction.command'");
		});

		it.each([0, -1])("rejects action with non-positive timeout %s in parseEvent", (timeout) => {
			const dir = createTempDir();
			const watcher = createWatcher(dir);
			const privateApi = getEventsWatcherPrivateApi(watcher);

			expect(() =>
				privateApi.parseEvent(
					JSON.stringify({
						type: "one-shot",
						at: "2030-01-01T00:00:00.000Z",
						channelId: "dm_1",
						text: "hello",
						preAction: { type: "bash", command: "true", timeout },
					}),
					"invalid-timeout.json",
				),
			).toThrow("Invalid 'preAction.timeout'");
		});
	});
});
