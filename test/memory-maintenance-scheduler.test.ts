import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { discoverMemoryMaintenanceChannels, MemoryMaintenanceScheduler } from "../src/memory/scheduler.js";
import { formatLocalTime } from "../src/shared/local-time.js";
import { useTempDirs } from "./helpers/fixtures.js";

const createTempDir = useTempDirs("pipiclaw-maintenance-scheduler-");

function maintenanceSettings(enabled = true) {
	return {
		enabled,
		minIdleMinutesBeforeLlmWork: 10,
		sessionRefreshIntervalMinutes: 10,
		checkpointIntervalMinutes: 20,
		minMemoryAutoWriteConfidence: 0.85,
		structuralMaintenanceIntervalHours: 6,
		maxConcurrentChannels: 1,
		failureBackoffMinutes: 30,
		cleanupShrinkGuardMinRatio: 0.4,
		cleanupShrinkGuardMinChars: 2_000,
	};
}

function sessionMemorySettings() {
	return {
		enabled: true,
		minTurnsBetweenUpdate: 2,
		minToolCallsBetweenUpdate: 4,
		timeoutMs: 30_000,
		forceRefreshBeforeCompact: true,
		forceRefreshBeforeNewSession: true,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("memory maintenance scheduler", () => {
	it("discovers legal channels from workspace, state, and known ids", async () => {
		const root = createTempDir();
		const workspaceDir = join(root, "workspace");
		const appHomeDir = join(root, "app");
		mkdirSync(join(workspaceDir, "dm_workspace"), { recursive: true });
		mkdirSync(join(workspaceDir, "events"), { recursive: true });
		mkdirSync(join(appHomeDir, "state", "memory"), { recursive: true });
		writeFileSync(join(appHomeDir, "state", "memory", "group_state.json"), "{}\n", "utf-8");
		writeFileSync(join(appHomeDir, "state", "memory", "bad.json"), "{}\n", "utf-8");

		await expect(
			discoverMemoryMaintenanceChannels({
				appHomeDir,
				workspaceDir,
				knownChannelIds: ["dm_known", "not_channel"],
			}),
		).resolves.toEqual(["dm_known", "dm_workspace", "group_state"]);
	});

	it("visits a slash-bearing group once, under the id the runtime can act on", async () => {
		// The same channel is reachable three ways, and two of them can only name it by its
		// escaped directory form. Without collapsing them, maintenance ran up to three times per
		// tick on one channel — twice under an id no transport or runner map can resolve.
		const root = createTempDir();
		const workspaceDir = join(root, "workspace");
		const appHomeDir = join(root, "app");
		const channelId = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
		const escaped = "group_cidYDhGqxhJOzS7VDv__eDInUw==";
		mkdirSync(join(workspaceDir, escaped), { recursive: true });
		mkdirSync(join(appHomeDir, "state", "memory"), { recursive: true });
		writeFileSync(join(appHomeDir, "state", "memory", `${escaped}.json`), "{}\n", "utf-8");

		await expect(
			discoverMemoryMaintenanceChannels({ appHomeDir, workspaceDir, knownChannelIds: [channelId] }),
		).resolves.toEqual([channelId]);
	});

	it("does not request runtime context when disabled", async () => {
		const root = createTempDir();
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			workspaceDir: join(root, "workspace"),
			getKnownChannelIds: () => ["dm_1"],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({ memoryMaintenance: maintenanceSettings(false), sessionMemory: sessionMemorySettings() }),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).not.toHaveBeenCalled();
	});

	it("honors maxConcurrentChannels per tick", async () => {
		const root = createTempDir();
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			workspaceDir: join(root, "workspace"),
			getKnownChannelIds: () => ["dm_1", "dm_2"],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({
				memoryMaintenance: {
					...maintenanceSettings(true),
					maxConcurrentChannels: 1,
				},
				sessionMemory: sessionMemorySettings(),
			}),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).toHaveBeenCalledTimes(1);
	});

	it("fills tick slots by skipping active channels in the ring", async () => {
		const root = createTempDir();
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			workspaceDir: join(root, "workspace"),
			getKnownChannelIds: () => ["dm_1", "dm_2", "dm_3"],
			getRuntimeContext,
			isChannelActive: (channelId) => channelId === "dm_1",
			getSettings: () => ({
				memoryMaintenance: {
					...maintenanceSettings(true),
					maxConcurrentChannels: 1,
				},
				sessionMemory: sessionMemorySettings(),
			}),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).toHaveBeenCalledTimes(1);
		expect(getRuntimeContext).toHaveBeenCalledWith("dm_2");
	});

	it("skips channels with nothing due without requesting runtime context", async () => {
		const root = createTempDir();
		const appHomeDir = join(root, "app");
		const now = new Date("2026-04-19T12:00:00.000Z");

		// dm_1 has already had every job run within its interval and is clean: no job could
		// possibly be due, so the cheap pre-check should skip it without touching the runtime.
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			dirty: false,
			lastSessionRefreshAt: formatLocalTime(now),
			lastCheckpointAt: formatLocalTime(now),
			lastStructuralMaintenanceAt: formatLocalTime(now),
		}));
		// dm_2 has no state on disk (never maintained), so it is always a candidate.

		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir,
			workspaceDir: join(root, "workspace"),
			getKnownChannelIds: () => ["dm_1", "dm_2"],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({
				memoryMaintenance: { ...maintenanceSettings(true), maxConcurrentChannels: 1 },
				sessionMemory: sessionMemorySettings(),
			}),
		});

		await scheduler.runOnce(now);
		expect(getRuntimeContext).toHaveBeenCalledTimes(1);
		expect(getRuntimeContext).toHaveBeenCalledWith("dm_2");
	});

	it("starts and stops an idempotent interval regardless of the enabled setting", async () => {
		vi.useFakeTimers();
		const root = createTempDir();
		let enabled = false;
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			workspaceDir: join(root, "workspace"),
			getKnownChannelIds: () => ["dm_1"],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({
				memoryMaintenance: maintenanceSettings(enabled),
				sessionMemory: sessionMemorySettings(),
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
