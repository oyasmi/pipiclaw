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

vi.mock("../src/memory/sidecar-worker.js", () => ({
	runSidecarTask: vi.fn(),
	runRetriedSidecarTask: vi.fn(),
}));

import { runInlineConsolidation } from "../src/memory/consolidation.js";
import { ensureChannelMemoryFiles } from "../src/memory/files.js";
import {
	runMemoryCheckpointJob,
	runSessionRefreshJob,
	runStructuralMaintenanceJob,
} from "../src/memory/maintenance-jobs.js";
import { readMemoryMaintenanceState, updateMemoryMaintenanceState } from "../src/memory/maintenance-state.js";
import { updateChannelSessionMemory } from "../src/memory/session.js";
import { runSidecarTask } from "../src/memory/sidecar-worker.js";
import { useTempDirs } from "./helpers/fixtures.js";

const makeTempDir = useTempDirs("pipiclaw-maintenance-jobs-");
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
			forceRefreshBeforeCompact: true,
			forceRefreshBeforeNewSession: true,
		},
		memoryMaintenance: {
			enabled: true,
			minIdleMinutesBeforeLlmWork: 10,
			sessionRefreshIntervalMinutes: 10,
			checkpointIntervalMinutes: 20,
			minMemoryAutoWriteConfidence: 0.85,
			structuralMaintenanceIntervalHours: 6,
			maxConcurrentChannels: 1,
			failureBackoffMinutes: 30,
			cleanupShrinkGuardMinRatio: 0.4,
			cleanupShrinkGuardMinChars: 2_000,
		},
	};
}

async function harness() {
	const workspaceDir = makeTempDir();
	const appHomeDir = join(workspaceDir, ".app");
	const channelDir = join(workspaceDir, "dm_1");
	await ensureChannelMemoryFiles(channelDir);
	return { appHomeDir, channelDir, workspaceDir };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("memory maintenance jobs", () => {
	it.each([
		{
			label: "session refresh job when the gate denies (clean)",
			runJob: runSessionRefreshJob,
			setup: async (_appHomeDir: string) => {},
			skipReason: "clean",
			calledMock: updateChannelSessionMemory,
		},
		{
			label: "checkpoint job when the gate denies (not idle yet)",
			runJob: runMemoryCheckpointJob,
			setup: async (appHomeDir: string) =>
				updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
					...state,
					dirty: true,
					eligibleAfter: "2999-01-01T00:00:00.000Z",
				})),
			skipReason: "not-idle-yet",
			calledMock: runInlineConsolidation,
		},
		{
			label: "structural maintenance job when files are under threshold",
			runJob: runStructuralMaintenanceJob,
			setup: async (_appHomeDir: string) => {},
			skipReason: "nothing-to-maintain",
			calledMock: runSidecarTask,
		},
	])("does not call the sidecar for $label", async ({ runJob, setup, skipReason, calledMock }) => {
		const { appHomeDir, channelDir } = await harness();
		await setup(appHomeDir);

		const result = await runJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			channelActive: false,
			settings: settings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		});

		expect(result).toMatchObject({ skipped: true, skipReason });
		expect(calledMock).not.toHaveBeenCalled();
	});

	it("passes only entries after the checkpoint cursor to consolidation", async () => {
		const { appHomeDir, channelDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			dirty: true,
			eligibleAfter: "2026-01-01T00:00:00.000Z",
			lastCheckpointEntryId: "entry-2",
		}));
		vi.mocked(runInlineConsolidation).mockResolvedValue({
			skipped: false,
			appendedMemoryEntries: 0,
			appendedDurableEntries: 0,
			appendedProbationaryEntries: 0,
			appendedHistoryBlock: false,
			rejectedMemoryOps: [],
		});
		const allEntries = [
			...sessionEntries,
			{ id: "entry-3", type: "message", message: { role: "user", content: "new request" } },
			{
				id: "entry-4",
				type: "message",
				message: { role: "assistant", content: [{ type: "text", text: "new reply" }] },
			},
		] as never[];
		await runMemoryCheckpointJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			channelActive: false,
			settings: settings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => allEntries,
		});
		expect(runInlineConsolidation).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceWindow: expect.objectContaining({
					entries: expect.arrayContaining([expect.objectContaining({ id: "entry-3" })]),
					fromEntryId: "entry-2",
					throughEntryId: "entry-4",
				}),
			}),
		);
	});

	it("keeps the checkpoint cursor and sets backoff when consolidation fails", async () => {
		const { appHomeDir, channelDir } = await harness();
		await updateMemoryMaintenanceState(appHomeDir, "dm_1", (state) => ({
			...state,
			dirty: true,
			eligibleAfter: "2026-01-01T00:00:00.000Z",
		}));
		vi.mocked(runInlineConsolidation).mockRejectedValue(new Error("model timeout"));
		const result = await runMemoryCheckpointJob({
			appHomeDir,
			channelId: "dm_1",
			channelDir,
			channelActive: false,
			settings: settings(),
			model: TEST_MODEL,
			resolveApiKey: async () => "",
			messages: () => messages,
			sessionEntries: () => sessionEntries,
		});
		expect(result.error).toContain("model timeout");
		const state = await readMemoryMaintenanceState(appHomeDir, "dm_1");
		expect(state.lastCheckpointEntryId).toBeUndefined();
		expect(state.failureBackoffUntil).toBeTruthy();
	});
});
