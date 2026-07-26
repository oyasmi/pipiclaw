import { describe, expect, it, vi } from "vitest";
import {
	shouldRunMemoryCheckpoint,
	shouldRunSessionRefresh,
	shouldRunStructuralMaintenance,
} from "../src/memory/maintenance-gates.js";
import type { MemoryMaintenanceState } from "../src/memory/maintenance-state.js";

const now = new Date("2026-04-19T01:00:00.000Z");

const state: MemoryMaintenanceState = {
	channelId: "dm_1",
	dirty: true,
	eligibleAfter: "2026-04-19T00:00:00.000Z",
	turnsSinceSessionRefresh: 12,
	toolCallsSinceSessionRefresh: 0,
	failureBackoffUntil: null,
};

const sessionMemory = {
	enabled: true,
	minTurnsBetweenUpdate: 2,
	minToolCallsBetweenUpdate: 4,
	timeoutMs: 30000,
	forceRefreshBeforeCompact: true,
	forceRefreshBeforeNewSession: true,
};

const maintenance = {
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
};

const checkpointMaterial = (batchSize: number) => () => ({
	hasNewEntry: true,
	hasMeaningfulExchange: true,
	batchSize,
});

const structuralMaterial = (memoryCleanupNeeded: boolean) => async () => ({
	memoryCleanupNeeded,
	historyFoldingNeeded: false,
	hasMemoryContent: true,
	hasHistoryContent: true,
});

describe("memory maintenance gates", () => {
	it("denies session refresh locally before any LLM work is needed", () => {
		expect(
			shouldRunSessionRefresh({
				now,
				state: { ...state, dirty: false },
				sessionMemory,
				maintenance,
				channelActive: false,
				hasNewSessionEntry: () => true,
				hasMeaningfulMaterial: () => true,
			}),
		).toMatchObject({ allowed: false, skipReason: "clean" });
		expect(
			shouldRunSessionRefresh({
				now,
				state,
				sessionMemory,
				maintenance,
				channelActive: true,
				hasNewSessionEntry: () => true,
				hasMeaningfulMaterial: () => true,
			}),
		).toMatchObject({ allowed: false, skipReason: "channel-active" });
		expect(
			shouldRunSessionRefresh({
				now,
				state,
				sessionMemory,
				maintenance,
				channelActive: false,
				hasNewSessionEntry: () => false,
				hasMeaningfulMaterial: () => true,
			}),
		).toMatchObject({ allowed: false, skipReason: "no-new-session-entry" });
	});

	it("allows the memory checkpoint only when local gates pass", () => {
		expect(
			shouldRunMemoryCheckpoint({
				now,
				state,
				maintenance,
				channelActive: false,
				material: checkpointMaterial(2),
			}),
		).toMatchObject({ allowed: true });
		expect(
			shouldRunMemoryCheckpoint({
				now,
				state,
				maintenance,
				channelActive: false,
				material: checkpointMaterial(1),
			}),
		).toMatchObject({ allowed: false, skipReason: "batch-threshold-not-met" });
		expect(
			shouldRunMemoryCheckpoint({
				now,
				state: { ...state, lastCheckpointAt: "2026-04-19T00:55:00.000Z" },
				maintenance,
				channelActive: false,
				material: checkpointMaterial(2),
			}),
		).toMatchObject({ allowed: false, skipReason: "interval-not-elapsed" });
	});

	it("splits structural cleanup and folding decisions", async () => {
		expect(
			await shouldRunStructuralMaintenance({
				now,
				state,
				maintenance,
				channelActive: false,
				material: structuralMaterial(true),
			}),
		).toMatchObject({ allowed: true, runMemoryCleanup: true, runHistoryFolding: false });
		expect(
			await shouldRunStructuralMaintenance({
				now,
				state,
				maintenance,
				channelActive: false,
				material: structuralMaterial(false),
			}),
		).toMatchObject({ allowed: false, skipReason: "nothing-to-maintain" });
	});

	// The whole point of the thunks: an idle daemon ticks every minute, and a tick that stops at a
	// schedule gate must not scan the transcript or read MEMORY.md/HISTORY.md to find that out.
	it("never evaluates material when a cheap schedule gate denies", async () => {
		const material = vi.fn(() => ({ hasNewEntry: true, hasMeaningfulExchange: true, batchSize: 9 }));
		const sessionMaterial = vi.fn(() => true);
		const structural = vi.fn(async () => ({
			memoryCleanupNeeded: true,
			historyFoldingNeeded: true,
			hasMemoryContent: true,
			hasHistoryContent: true,
		}));

		shouldRunSessionRefresh({
			now,
			state: { ...state, dirty: false },
			sessionMemory,
			maintenance,
			channelActive: false,
			hasNewSessionEntry: sessionMaterial,
			hasMeaningfulMaterial: sessionMaterial,
		});
		shouldRunMemoryCheckpoint({ now, state, maintenance, channelActive: true, material });
		await shouldRunStructuralMaintenance({ now, state, maintenance, channelActive: true, material: structural });

		expect(sessionMaterial).not.toHaveBeenCalled();
		expect(material).not.toHaveBeenCalled();
		expect(structural).not.toHaveBeenCalled();
	});
});
