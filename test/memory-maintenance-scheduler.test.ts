import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { MemoryMaintenanceScheduler } from "../src/memory/scheduler.js";
import { formatLocalTime } from "../src/shared/local-time.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-maintenance-scheduler-");

function maintenanceSettings(enabled = true) {
	return {
		enabled,
		minIdleMinutesBeforeLlmWork: 10,
		reflectIntervalMinutes: 20,
		failureBackoffMinutes: 30,
	};
}

/** Bound conversations of an active desk, as the runtime would inject them (spec 058, D12). */
function conv(channelId: string) {
	const index = channelId.slice(channelId.lastIndexOf("_") + 1);
	return {
		desk: "news",
		deskDir: "/tmp/desk-news",
		cwd: "/tmp/desk-news",
		channelId,
		conversation: `dm-${index}`,
		conversationDir: `/tmp/desk-news/conversations/dm-${index}`,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("memory maintenance scheduler", () => {
	it("does not request runtime context when disabled", async () => {
		const root = createTempDir();
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			getConversations: () => [conv("dm_1")],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({ memoryMaintenance: maintenanceSettings(false) }),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).not.toHaveBeenCalled();
	});

	it("reflects one channel per tick", async () => {
		const root = createTempDir();
		const appHomeDir = join(root, "app");
		await updateMemoryMaintenanceState(appHomeDir, conv("dm_1"), (state) => ({ ...state, dirty: true }));
		await updateMemoryMaintenanceState(appHomeDir, conv("dm_2"), (state) => ({ ...state, dirty: true }));
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir,
			getConversations: () => [conv("dm_1"), conv("dm_2")],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({
				memoryMaintenance: {
					...maintenanceSettings(true),
				},
			}),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).toHaveBeenCalledTimes(1);
	});

	it("skips active channels in the ring", async () => {
		const root = createTempDir();
		const appHomeDir = join(root, "app");
		for (const id of ["dm_1", "dm_2", "dm_3"]) {
			await updateMemoryMaintenanceState(appHomeDir, conv(id), (state) => ({ ...state, dirty: true }));
		}
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir,
			getConversations: () => [conv("dm_1"), conv("dm_2"), conv("dm_3")],
			getRuntimeContext,
			isChannelActive: (channelId) => channelId === "dm_1",
			getSettings: () => ({
				memoryMaintenance: {
					...maintenanceSettings(true),
				},
			}),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).toHaveBeenCalledTimes(1);
		expect(getRuntimeContext).toHaveBeenCalledWith(conv("dm_2"));
	});

	it("skips channels with nothing due without requesting runtime context", async () => {
		const root = createTempDir();
		const appHomeDir = join(root, "app");
		const now = new Date("2026-04-19T12:00:00.000Z");

		// dm_1 has already reflected within its interval and is clean: reflect could not possibly
		// be due, so the cheap pre-check should skip it without touching the runtime.
		await updateMemoryMaintenanceState(appHomeDir, conv("dm_1"), (state) => ({
			...state,
			dirty: false,
			lastReflectAt: formatLocalTime(now),
		}));
		// dm_2 is dirty with no prior reflect, so it is a candidate.
		await updateMemoryMaintenanceState(appHomeDir, conv("dm_2"), (state) => ({ ...state, dirty: true }));

		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir,
			getConversations: () => [conv("dm_1"), conv("dm_2")],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({
				memoryMaintenance: { ...maintenanceSettings(true) },
			}),
		});

		await scheduler.runOnce(now);
		expect(getRuntimeContext).toHaveBeenCalledTimes(1);
		expect(getRuntimeContext).toHaveBeenCalledWith(conv("dm_2"));
	});

	it("starts and stops an idempotent interval regardless of the enabled setting", async () => {
		vi.useFakeTimers();
		const root = createTempDir();
		let enabled = false;
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			getConversations: () => [conv("dm_1")],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({
				memoryMaintenance: maintenanceSettings(enabled),
			}),
			intervalMs: 1000,
		});
		const runOnce = vi.spyOn(scheduler, "runOnce").mockResolvedValue(undefined);

		// Starting while disabled now still arms the timer; runOnce itself is the enabled gate.
		scheduler.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(runOnce).toHaveBeenCalledTimes(1);

		// Flipping the setting on at runtime (no restart) takes effect on the next tick.
		enabled = true;
		scheduler.start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(runOnce).toHaveBeenCalledTimes(2);

		scheduler.stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(runOnce).toHaveBeenCalledTimes(2);
		scheduler.stop();
	});
});
