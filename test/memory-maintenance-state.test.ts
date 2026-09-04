import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannelMemoryQueue } from "../src/memory/channel-maintenance-queue.js";
import {
	applyMemoryActivityToState,
	createMemoryActivityRecorder,
	getMemoryMaintenanceStatePath,
	type MemoryActivityEvent,
	readMemoryMaintenanceState,
	updateMemoryMaintenanceState,
} from "../src/memory/maintenance-state.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-maintenance-state-");

function activity(kind: MemoryActivityEvent["kind"]): MemoryActivityEvent {
	return { kind, channelId: "dm_1", timestamp: "2026-04-19T00:00:00.000Z" };
}

describe("channel maintenance queue", () => {
	it("serializes same-channel jobs and continues after failures", async () => {
		const queue = createChannelMemoryQueue();
		const events: string[] = [];
		let releaseFirst!: () => void;

		const first = queue.run("dm_1", async () => {
			events.push("first-start");
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			events.push("first-end");
		});
		const second = queue.run("dm_1", async () => {
			events.push("second");
			throw new Error("boom");
		});
		const third = queue.run("dm_1", async () => {
			events.push("third");
		});

		await Promise.resolve();
		await Promise.resolve();
		expect(events).toEqual(["first-start"]);
		releaseFirst();
		await first;
		await expect(second).rejects.toThrow("boom");
		await third;
		expect(events).toEqual(["first-start", "first-end", "second", "third"]);
	});
});

describe("memory maintenance state", () => {
	it("returns defaults, rebuilds corrupt state, and updates atomically", async () => {
		const appHomeDir = createTempDir();
		const path = getMemoryMaintenanceStatePath(appHomeDir, "dm_1");

		await expect(readMemoryMaintenanceState(appHomeDir, "dm_1")).resolves.toMatchObject({
			channelId: "dm_1",
			dirty: false,
		});

		await mkdir(join(appHomeDir, "state", "memory"), { recursive: true });
		await writeFile(path, "{bad json", "utf-8");
		await expect(readMemoryMaintenanceState(appHomeDir, "dm_1")).resolves.toMatchObject({
			channelId: "dm_1",
			dirty: false,
		});

		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) =>
			applyMemoryActivityToState(state, {
				kind: "assistant-turn-completed",
				channelId: "dm_1",
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
				updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) =>
					applyMemoryActivityToState(state, {
						kind: index % 2 === 0 ? "assistant-turn-completed" : "tool-call",
						channelId: "dm_1",
						timestamp: `2026-04-19T00:00:${String(index).padStart(2, "0")}.000Z`,
					}),
				),
			),
		);

		const state = await readMemoryMaintenanceState(appHomeDir, "dm_1");
		expect(state).toMatchObject({ dirty: true });
	});

	it("folds the v1 checkpoint job's fields into the reflect cadence/cursor", async () => {
		const appHomeDir = createTempDir();
		const path = getMemoryMaintenanceStatePath(appHomeDir, "dm_1");
		await mkdir(join(appHomeDir, "state", "memory"), { recursive: true });
		await writeFile(
			path,
			JSON.stringify({
				channelId: "dm_1",
				dirty: true,
				lastCheckpointAt: "2026-04-19T00:40:00.000Z",
				lastCheckpointEntryId: "entry-7",
			}),
			"utf-8",
		);

		await expect(readMemoryMaintenanceState(appHomeDir, "dm_1")).resolves.toMatchObject({
			lastReflectAt: "2026-04-19T00:40:00.000Z",
			lastReflectedEntryId: "entry-7",
		});
	});

	it("keeps a slash-bearing channel's state in one flat, listable file", async () => {
		const appHomeDir = createTempDir();
		const channelId = "group_cidYDhGqxhJOzS7VDv/eDInUw==";

		await updateMemoryMaintenanceState(appHomeDir, channelId, (state) => ({ ...state, dirty: true }));

		// Written raw, the id turned into a subdirectory (`group_.../eDInUw==.json`), which the
		// scheduler's top-level listing of this directory never saw.
		const stateDir = join(appHomeDir, "state", "memory");
		expect(await readdir(stateDir)).toEqual(["group_cidYDhGqxhJOzS7VDv__eDInUw==.json"]);
		expect(getMemoryMaintenanceStatePath(appHomeDir, channelId)).toBe(
			join(stateDir, "group_cidYDhGqxhJOzS7VDv__eDInUw==.json"),
		);
	});

	it("adopts state left at the pre-escaping path instead of restarting the cadence", async () => {
		const appHomeDir = createTempDir();
		const channelId = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
		const legacyPath = join(appHomeDir, "state", "memory", `${channelId}.json`);
		await mkdir(join(legacyPath, ".."), { recursive: true });
		await writeFile(
			legacyPath,
			JSON.stringify({ channelId, dirty: true, lastReflectAt: "2026-04-19T00:40:00.000Z" }),
			"utf-8",
		);

		// Losing this would re-run the reflect pass on the channel's whole unreflected history.
		await expect(readMemoryMaintenanceState(appHomeDir, channelId)).resolves.toMatchObject({
			lastReflectAt: "2026-04-19T00:40:00.000Z",
		});

		await updateMemoryMaintenanceState(appHomeDir, channelId, (state) => ({ ...state, dirty: false }));

		expect(existsSync(getMemoryMaintenanceStatePath(appHomeDir, channelId))).toBe(true);
		expect(existsSync(legacyPath)).toBe(false); // migrated, not duplicated
		expect(existsSync(join(legacyPath, ".."))).toBe(false); // and no stray channel-shaped dir
		await expect(readMemoryMaintenanceState(appHomeDir, channelId)).resolves.toMatchObject({
			lastReflectAt: "2026-04-19T00:40:00.000Z",
		});
	});

	it("does not mark a user-turn-started event as dirty by itself", () => {
		const next = applyMemoryActivityToState(
			{ channelId: "dm_1", dirty: false, failureBackoffUntil: null },
			{
				kind: "user-turn-started",
				channelId: "dm_1",
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
			onError: (_channelId, error) => {
				throw error;
			},
		});
		for (const event of events) {
			recorder.record(event);
		}
		// Nothing has touched disk yet: the whole burst is still buffered.
		expect(await readMemoryMaintenanceState(appHomeDir, "dm_1")).toMatchObject({ dirty: false });

		await recorder.flush("dm_1");
		const batched = await readMemoryMaintenanceState(appHomeDir, "dm_1");

		// The same events applied one at a time, the way the runtime used to write them.
		const perEventDir = createTempDir();
		for (const event of events) {
			await updateMemoryMaintenanceState(perEventDir, "dm_1", (state) => applyMemoryActivityToState(state, event));
		}
		const perEvent = await readMemoryMaintenanceState(perEventDir, "dm_1");

		expect(batched).toEqual(perEvent);
		expect(batched).toMatchObject({ dirty: true });
	});

	it("flushes on the debounce and accumulates onto state written by other writers", async () => {
		const appHomeDir = createTempDir();
		const recorder = createMemoryActivityRecorder({ appHomeDir, debounceMs: 5 });

		// A checkpoint written directly, as the reflect job path does.
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			lastReflectedEntryId: "entry-99",
		}));

		recorder.record(activity("tool-call"));
		await new Promise((resolve) => setTimeout(resolve, 30));

		const state = await readMemoryMaintenanceState(appHomeDir, "dm_1");
		// The debounced write must not clobber a field a direct writer already set.
		expect(state.dirty).toBe(true);
		expect(state.lastReflectedEntryId).toBe("entry-99");
	});

	it("flush is idempotent and covers every buffered channel", async () => {
		const appHomeDir = createTempDir();
		const recorder = createMemoryActivityRecorder({ appHomeDir, debounceMs: 60_000 });

		recorder.record({ ...activity("tool-call"), channelId: "dm_a" });
		recorder.record({ ...activity("tool-call"), channelId: "dm_b" });
		await recorder.flush();
		await recorder.flush();

		expect((await readMemoryMaintenanceState(appHomeDir, "dm_a")).dirty).toBe(true);
		expect((await readMemoryMaintenanceState(appHomeDir, "dm_b")).dirty).toBe(true);
	});
});
