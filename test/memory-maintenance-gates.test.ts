import { describe, expect, it } from "vitest";
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
	failureBackoffTurns: 3,
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

describe("memory maintenance gates", () => {
	it("denies session refresh locally before any LLM work is needed", () => {
		expect(
			shouldRunSessionRefresh({
				now,
				state: { ...state, dirty: false },
				sessionMemory,
				maintenance,
				channelActive: false,
				hasNewSessionEntry: true,
				hasMeaningfulMaterial: true,
			}),
		).toMatchObject({ allowed: false, skipReason: "clean" });
		expect(
			shouldRunSessionRefresh({
				now,
				state,
				sessionMemory,
				maintenance,
				channelActive: true,
				hasNewSessionEntry: true,
				hasMeaningfulMaterial: true,
			}),
		).toMatchObject({ allowed: false, skipReason: "channel-active" });
		expect(
			shouldRunSessionRefresh({
				now,
				state,
				sessionMemory,
				maintenance,
				channelActive: false,
				hasNewSessionEntry: false,
				hasMeaningfulMaterial: true,
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
				hasNewEntry: true,
				hasMeaningfulExchange: true,
				batchSize: 2,
			}),
		).toMatchObject({ allowed: true });
		expect(
			shouldRunMemoryCheckpoint({
				now,
				state,
				maintenance,
				channelActive: false,
				hasNewEntry: true,
				hasMeaningfulExchange: true,
				batchSize: 1,
			}),
		).toMatchObject({ allowed: false, skipReason: "batch-threshold-not-met" });
		expect(
			shouldRunMemoryCheckpoint({
				now,
				state: { ...state, lastCheckpointAt: "2026-04-19T00:55:00.000Z" },
				maintenance,
				channelActive: false,
				hasNewEntry: true,
				hasMeaningfulExchange: true,
				batchSize: 2,
			}),
		).toMatchObject({ allowed: false, skipReason: "interval-not-elapsed" });
	});

	it("splits structural cleanup and folding decisions", () => {
		expect(
			shouldRunStructuralMaintenance({
				now,
				state,
				maintenance,
				channelActive: false,
				memoryCleanupNeeded: true,
				historyFoldingNeeded: false,
				hasMemoryContent: true,
				hasHistoryContent: true,
			}),
		).toMatchObject({ allowed: true, runMemoryCleanup: true, runHistoryFolding: false });
		expect(
			shouldRunStructuralMaintenance({
				now,
				state,
				maintenance,
				channelActive: false,
				memoryCleanupNeeded: false,
				historyFoldingNeeded: false,
				hasMemoryContent: true,
				hasHistoryContent: true,
			}),
		).toMatchObject({ allowed: false, skipReason: "nothing-to-maintain" });
	});
});
