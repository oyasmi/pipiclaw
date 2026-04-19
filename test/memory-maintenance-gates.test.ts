import { describe, expect, it } from "vitest";
import {
	shouldRunDurableConsolidation,
	shouldRunGrowthReview,
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
	turnsSinceGrowthReview: 12,
	toolCallsSinceGrowthReview: 0,
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

const memoryGrowth = {
	postTurnReviewEnabled: true,
	autoWriteChannelMemory: true,
	autoWriteWorkspaceSkills: false,
	minSkillAutoWriteConfidence: 0.9,
	minMemoryAutoWriteConfidence: 0.85,
	idleWritesHistory: false,
	minTurnsBetweenReview: 12,
	minToolCallsBetweenReview: 24,
};

const maintenance = {
	enabled: true,
	minIdleMinutesBeforeLlmWork: 10,
	sessionRefreshIntervalMinutes: 10,
	durableConsolidationIntervalMinutes: 20,
	growthReviewIntervalMinutes: 60,
	structuralMaintenanceIntervalHours: 6,
	maxConcurrentChannels: 1,
	failureBackoffMinutes: 30,
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

	it("allows durable and growth jobs only when local gates pass", () => {
		expect(
			shouldRunDurableConsolidation({
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
			shouldRunGrowthReview({
				now,
				state,
				memoryGrowth,
				maintenance,
				channelActive: false,
				hasNewEntry: true,
				hasMeaningfulMaterial: true,
				hasPromotionSignal: false,
			}),
		).toMatchObject({ allowed: false, skipReason: "no-promotion-signal" });
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
