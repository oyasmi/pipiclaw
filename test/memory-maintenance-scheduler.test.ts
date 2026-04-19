import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverMemoryMaintenanceChannels, MemoryMaintenanceScheduler } from "../src/memory/scheduler.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipiclaw-maintenance-scheduler-"));
	tempDirs.push(dir);
	return dir;
}

function maintenanceSettings(enabled = true) {
	return {
		enabled,
		minIdleMinutesBeforeLlmWork: 10,
		sessionRefreshIntervalMinutes: 10,
		durableConsolidationIntervalMinutes: 20,
		growthReviewIntervalMinutes: 60,
		structuralMaintenanceIntervalHours: 6,
		maxConcurrentChannels: 1,
		failureBackoffMinutes: 30,
	};
}

afterEach(() => {
	vi.useRealTimers();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
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

	it("does not request runtime context when disabled", async () => {
		const root = createTempDir();
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			workspaceDir: join(root, "workspace"),
			getKnownChannelIds: () => ["dm_1"],
			getRuntimeContext,
			isChannelActive: () => false,
			getSettings: () => ({ memoryMaintenance: maintenanceSettings(false) }),
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
			}),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).toHaveBeenCalledTimes(1);
	});

	it("does not build runtime context for active channels", async () => {
		const root = createTempDir();
		const getRuntimeContext = vi.fn(async () => null);
		const scheduler = new MemoryMaintenanceScheduler({
			appHomeDir: join(root, "app"),
			workspaceDir: join(root, "workspace"),
			getKnownChannelIds: () => ["dm_1"],
			getRuntimeContext,
			isChannelActive: () => true,
			getSettings: () => ({ memoryMaintenance: maintenanceSettings(true) }),
		});

		await scheduler.runOnce();
		expect(getRuntimeContext).not.toHaveBeenCalled();
	});
});
