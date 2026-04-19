import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/session.js", () => ({
	updateChannelSessionMemory: vi.fn(),
}));

vi.mock("../src/memory/consolidation.js", async () => {
	const actual = await vi.importActual<typeof import("../src/memory/consolidation.js")>(
		"../src/memory/consolidation.js",
	);
	return {
		...actual,
		runInlineConsolidation: vi.fn(),
	};
});

vi.mock("../src/memory/post-turn-review.js", () => ({
	runPostTurnReview: vi.fn(),
}));

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
}));

import { runInlineConsolidation } from "../src/memory/consolidation.js";
import { ensureChannelMemoryFiles } from "../src/memory/files.js";
import {
	runDurableConsolidationJob,
	runGrowthReviewJob,
	runSessionRefreshJob,
	runStructuralMaintenanceJob,
} from "../src/memory/maintenance-jobs.js";
import { updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { runPostTurnReview } from "../src/memory/post-turn-review.js";
import { updateChannelSessionMemory } from "../src/memory/session.js";
import { runSidecarTask } from "../src/memory/sidecar-worker.js";

const tempDirs: string[] = [];
const TEST_MODEL = { provider: "test", id: "noop" } as never;
const messages = [
	{ role: "user", content: "Please remember the deployment decision." },
	{ role: "assistant", content: [{ type: "text", text: "Confirmed the deployment decision." }] },
] as never[];
const sessionEntries = [
	{ id: "entry-1", type: "message", message: messages[0] },
	{ id: "entry-2", type: "message", message: messages[1] },
] as never[];

function settings() {
	return {
		sessionMemory: {
			enabled: true,
			minTurnsBetweenUpdate: 2,
			minToolCallsBetweenUpdate: 4,
			timeoutMs: 30000,
			failureBackoffTurns: 3,
			forceRefreshBeforeCompact: true,
			forceRefreshBeforeNewSession: true,
		},
		memoryGrowth: {
			postTurnReviewEnabled: true,
			autoWriteChannelMemory: true,
			autoWriteWorkspaceSkills: false,
			minSkillAutoWriteConfidence: 0.9,
			minMemoryAutoWriteConfidence: 0.85,
			idleWritesHistory: false,
			minTurnsBetweenReview: 12,
			minToolCallsBetweenReview: 24,
		},
		memoryMaintenance: {
			enabled: true,
			minIdleMinutesBeforeLlmWork: 10,
			sessionRefreshIntervalMinutes: 10,
			durableConsolidationIntervalMinutes: 20,
			growthReviewIntervalMinutes: 60,
			structuralMaintenanceIntervalHours: 6,
			maxConcurrentChannels: 1,
			failureBackoffMinutes: 30,
		},
	};
}

async function harness() {
	const workspaceDir = mkdtempSync(join(tmpdir(), "pipiclaw-maintenance-jobs-"));
	tempDirs.push(workspaceDir);
	const appHomeDir = join(workspaceDir, ".app");
	const channelDir = join(workspaceDir, "dm_1");
	await ensureChannelMemoryFiles(channelDir);
	return { appHomeDir, channelDir, workspaceDir };
}

afterEach(() => {
	vi.clearAllMocks();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("memory maintenance jobs", () => {
	it("does not call session refresh sidecar when the gate denies", async () => {
		const { appHomeDir, channelDir } = await harness();
		const result = await runSessionRefreshJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			channelActive: false,
			settings: settings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages,
			sessionEntries,
		});

		expect(result).toMatchObject({ skipped: true, skipReason: "clean" });
		expect(updateChannelSessionMemory).not.toHaveBeenCalled();
	});

	it("does not call durable consolidation sidecar when the gate denies", async () => {
		const { appHomeDir, channelDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			dirty: true,
			eligibleAfter: "2999-01-01T00:00:00.000Z",
		}));

		const result = await runDurableConsolidationJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			channelActive: false,
			settings: settings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages,
			sessionEntries,
		});

		expect(result).toMatchObject({ skipped: true, skipReason: "not-idle-yet" });
		expect(runInlineConsolidation).not.toHaveBeenCalled();
	});

	it("does not call growth review sidecar without local promotion signals", async () => {
		const { appHomeDir, channelDir, workspaceDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			dirty: true,
			turnsSinceGrowthReview: 12,
			eligibleAfter: "2026-04-19T00:00:00.000Z",
		}));

		const result = await runGrowthReviewJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			channelActive: false,
			settings: settings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: [
				{ role: "user", content: "Please inspect this file." },
				{ role: "assistant", content: [{ type: "text", text: "Inspected it." }] },
			] as never[],
			sessionEntries,
			workspaceDir,
			workspacePath: workspaceDir,
			loadedSkills: [],
		});

		expect(result).toMatchObject({ skipped: true, skipReason: "no-promotion-signal" });
		expect(runPostTurnReview).not.toHaveBeenCalled();
	});

	it("does not call structural sidecars when files are under threshold", async () => {
		const { appHomeDir, channelDir } = await harness();
		const result = await runStructuralMaintenanceJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			channelActive: false,
			settings: settings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages,
			sessionEntries,
		});

		expect(result).toMatchObject({ skipped: true, skipReason: "nothing-to-maintain" });
		expect(runSidecarTask).not.toHaveBeenCalled();
	});
});
