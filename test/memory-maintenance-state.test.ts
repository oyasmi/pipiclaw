import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDeskLockPath } from "../src/desk/paths.js";
import { createDeskMemoryQueue } from "../src/memory/desk-memory-queue.js";
import {
	applyMemoryActivityToState,
	createMemoryActivityRecorder,
	getMemoryMaintenanceStatePath,
	type MaintenanceStateRef,
	type MemoryActivityEvent,
	readMemoryMaintenanceState,
	updateMemoryMaintenanceState,
} from "../src/memory/maintenance-state.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { spawnLockHolder } from "./helpers/lock-holder.js";

const createTempDir = useTempDirs("pipiclaw-maintenance-state-");

const REF: MaintenanceStateRef = { desk: "news", conversation: "dm-1", channelId: "dingtalk:dm:1" };

function activity(kind: MemoryActivityEvent["kind"], ref: MaintenanceStateRef = REF): MemoryActivityEvent {
	return { kind, ref, timestamp: "2026-04-19T00:00:00.000Z" };
}

describe("desk memory queue", () => {
	it("serializes same-desk jobs and continues after failures", async () => {
		const queue = createDeskMemoryQueue();
		const target = { desk: "news", deskDir: createTempDir() };
		const events: string[] = [];
		let releaseFirst!: () => void;
		let firstStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve;
		});

		const first = queue.run(target, async () => {
			events.push("first-start");
			firstStarted();
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			events.push("first-end");
		});
		const second = queue.run(target, async () => {
			events.push("second");
			throw new Error("boom");
		});
		const third = queue.run(target, async () => {
			events.push("third");
		});

		await started;
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(events).toEqual(["first-start"]);
		releaseFirst();
		await first;
		await expect(second).rejects.toThrow("boom");
		await third;
		expect(events).toEqual(["first-start", "first-end", "second", "third"]);
	});

	it("waits while another process holds the desk's memory lock", async () => {
		// Failure caught (INV-6/INV-8): an in-process queue alone cannot see a TUI writing the same
		// desk, so both would rewrite memory/ and the generated MEMORY.md from stale reads.
		const target = { desk: "news", deskDir: createTempDir() };
		const holder = await spawnLockHolder(getDeskLockPath(target.deskDir, "memory.lock"));
		let ran = false;
		const job = createDeskMemoryQueue().run(target, async () => {
			ran = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(ran).toBe(false);
		await holder.release();
		await job;
		expect(ran).toBe(true);
	});
});

describe("memory maintenance state", () => {
	it("returns defaults, rebuilds corrupt state, and updates atomically", async () => {
		const appHomeDir = createTempDir();
		const path = getMemoryMaintenanceStatePath(appHomeDir, REF);

		await expect(readMemoryMaintenanceState(appHomeDir, REF)).resolves.toMatchObject({
			channelId: "dingtalk:dm:1",
			dirty: false,
		});

		await mkdir(join(appHomeDir, "state", "memory", "news"), { recursive: true });
		await writeFile(path, "{bad json", "utf-8");
		await expect(readMemoryMaintenanceState(appHomeDir, REF)).resolves.toMatchObject({
			channelId: "dingtalk:dm:1",
			dirty: false,
		});

		await updateMemoryMaintenanceState(appHomeDir, REF, (state) =>
			applyMemoryActivityToState(state, {
				kind: "assistant-turn-completed",
				ref: REF,
				timestamp: "2026-04-19T00:00:00.000Z",
				eligibleAfter: "2026-04-19T00:10:00.000Z",
			}),
		);

		const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
		expect(raw).toMatchObject({ dirty: true, eligibleAfter: "2026-04-19T00:10:00.000Z" });
	});

	it("serializes concurrent updates to the same channel state", async () => {
		const appHomeDir = createTempDir();
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				updateMemoryMaintenanceState(appHomeDir, REF, (state) =>
					applyMemoryActivityToState(state, {
						kind: index % 2 === 0 ? "assistant-turn-completed" : "tool-call",
						ref: REF,
						timestamp: `2026-04-19T00:00:${String(index).padStart(2, "0")}.000Z`,
					}),
				),
			),
		);

		const state = await readMemoryMaintenanceState(appHomeDir, REF);
		expect(state).toMatchObject({ dirty: true });
	});

	it("files state by desk and conversation, never by channel id", async () => {
		// Failure caught (INV-3): a base64 group id carries `/`; any path derived from it nests
		// or escapes the state directory.
		const appHomeDir = createTempDir();
		const ref = { desk: "news", conversation: "group-1", channelId: "dingtalk:group:cidYDhGqxhJOzS7VDv/eDInUw==" };

		await updateMemoryMaintenanceState(appHomeDir, ref, (state) => ({ ...state, dirty: true }));

		const stateDir = join(appHomeDir, "state", "memory");
		expect(await readdir(stateDir)).toEqual(["news"]);
		expect(await readdir(join(stateDir, "news"))).toEqual(["group-1.json"]);
		expect((await readMemoryMaintenanceState(appHomeDir, ref)).channelId).toBe(ref.channelId);
	});

	it("does not mark a user-turn-started event as dirty by itself", () => {
		const next = applyMemoryActivityToState(
			{ channelId: "dingtalk:dm:1", dirty: false, failureBackoffUntil: null },
			{
				kind: "user-turn-started",
				ref: REF,
				timestamp: "2026-04-19T00:00:00.000Z",
				eligibleAfter: "2026-04-19T00:10:00.000Z",
			},
		);

		expect(next).toMatchObject({ dirty: false, eligibleAfter: "2026-04-19T00:10:00.000Z" });
	});
});

describe("memory activity recorder", () => {
	it("collapses a burst into one write that matches event-by-event application", async () => {
		const appHomeDir = createTempDir();
		const events: MemoryActivityEvent[] = [
			activity("user-turn-started"),
			activity("tool-call"),
			activity("tool-call"),
			activity("tool-call"),
			activity("assistant-turn-completed"),
			activity("boundary"),
		];

		const recorder = createMemoryActivityRecorder({
			appHomeDir,
			debounceMs: 60_000, // long enough that only the explicit flush writes
			onError: (_ref, error) => {
				throw error;
			},
		});
		for (const event of events) {
			recorder.record(event);
		}
		// Nothing has touched disk yet: the whole burst is still buffered.
		expect(await readMemoryMaintenanceState(appHomeDir, REF)).toMatchObject({ dirty: false });

		await recorder.flush(REF);
		const batched = await readMemoryMaintenanceState(appHomeDir, REF);

		// The same events applied one at a time, the way the runtime used to write them.
		const perEventDir = createTempDir();
		for (const event of events) {
			await updateMemoryMaintenanceState(perEventDir, REF, (state) => applyMemoryActivityToState(state, event));
		}
		const perEvent = await readMemoryMaintenanceState(perEventDir, REF);

		expect(batched).toEqual(perEvent);
		expect(batched).toMatchObject({ dirty: true });
	});

	it("flushes on the debounce and accumulates onto state written by other writers", async () => {
		const appHomeDir = createTempDir();
		const recorder = createMemoryActivityRecorder({ appHomeDir, debounceMs: 5 });

		// A checkpoint written directly, as the reflect job path does.
		await updateMemoryMaintenanceState(appHomeDir, REF, (state) => ({
			...state,
			lastReflectedEntryId: "entry-99",
		}));

		recorder.record(activity("tool-call"));
		await new Promise((resolve) => setTimeout(resolve, 30));

		const state = await readMemoryMaintenanceState(appHomeDir, REF);
		// The debounced write must not clobber a field a direct writer already set.
		expect(state.dirty).toBe(true);
		expect(state.lastReflectedEntryId).toBe("entry-99");
	});

	it("flush is idempotent and covers every buffered conversation", async () => {
		const appHomeDir = createTempDir();
		const recorder = createMemoryActivityRecorder({ appHomeDir, debounceMs: 60_000 });
		const a = { desk: "news", conversation: "dm-1", channelId: "dingtalk:dm:a" };
		const b = { desk: "news", conversation: "dm-2", channelId: "dingtalk:dm:b" };

		recorder.record(activity("tool-call", a));
		recorder.record(activity("tool-call", b));
		await recorder.flush();
		await recorder.flush();

		expect((await readMemoryMaintenanceState(appHomeDir, a)).dirty).toBe(true);
		expect((await readMemoryMaintenanceState(appHomeDir, b)).dirty).toBe(true);
	});
});
