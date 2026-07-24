import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createChannelMemoryQueue } from "../src/memory/channel-maintenance-queue.js";
import {
	applyMemoryActivityToState,
	getMemoryMaintenanceStatePath,
	readMemoryMaintenanceState,
	updateMemoryMaintenanceState,
} from "../src/memory/maintenance-state.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-maintenance-state-");

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
			turnsSinceSessionRefresh: 0,
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
				latestSessionEntryId: "entry-2",
			}),
		);

		const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
		expect(raw).toMatchObject({
			dirty: true,
			turnsSinceSessionRefresh: 1,
			lastSessionEntryId: "entry-2",
			eligibleAfter: "2026-04-19T00:10:00.000Z",
		});
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
		expect(state).toMatchObject({
			dirty: true,
			turnsSinceSessionRefresh: 6,
			toolCallsSinceSessionRefresh: 6,
		});
	});

	it("folds legacy consolidation/growth-review fields into the checkpoint", async () => {
		const appHomeDir = createTempDir();
		const path = getMemoryMaintenanceStatePath(appHomeDir, "dm_1");
		await mkdir(join(appHomeDir, "state", "memory"), { recursive: true });
		await writeFile(
			path,
			JSON.stringify({
				channelId: "dm_1",
				dirty: true,
				lastDurableConsolidationAt: "2026-04-19T00:20:00.000Z",
				lastGrowthReviewAt: "2026-04-19T00:40:00.000Z",
				lastConsolidatedEntryId: "entry-7",
				lastReviewedEntryId: "entry-5",
			}),
			"utf-8",
		);

		await expect(readMemoryMaintenanceState(appHomeDir, "dm_1")).resolves.toMatchObject({
			lastCheckpointAt: "2026-04-19T00:40:00.000Z",
			lastCheckpointEntryId: "entry-7",
		});
	});

	it("does not mark a user-turn-started event as dirty by itself", () => {
		const next = applyMemoryActivityToState(
			{
				channelId: "dm_1",
				dirty: false,
				turnsSinceSessionRefresh: 0,
				toolCallsSinceSessionRefresh: 0,
				failureBackoffUntil: null,
			},
			{
				kind: "user-turn-started",
				channelId: "dm_1",
				timestamp: "2026-04-19T00:00:00.000Z",
				eligibleAfter: "2026-04-19T00:10:00.000Z",
			},
		);

		expect(next).toMatchObject({
			dirty: false,
			eligibleAfter: "2026-04-19T00:10:00.000Z",
			turnsSinceSessionRefresh: 0,
			toolCallsSinceSessionRefresh: 0,
		});
	});
});
