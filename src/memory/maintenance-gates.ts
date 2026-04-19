import type {
	PipiclawMemoryGrowthSettings,
	PipiclawMemoryMaintenanceSettings,
	PipiclawSessionMemorySettings,
} from "../settings.js";
import type { MemoryMaintenanceState } from "./maintenance-state.js";

export type MaintenanceJobKind =
	| "session-refresh"
	| "durable-consolidation"
	| "growth-review"
	| "structural-maintenance";

export interface MaintenanceGateDecision {
	allowed: boolean;
	skipReason?: string;
	jobKind: MaintenanceJobKind;
}

export interface SessionRefreshGateInput {
	now: Date;
	state: MemoryMaintenanceState;
	sessionMemory: PipiclawSessionMemorySettings;
	maintenance: PipiclawMemoryMaintenanceSettings;
	channelActive: boolean;
	hasNewSessionEntry: boolean;
	hasMeaningfulMaterial: boolean;
}

export interface DurableConsolidationGateInput {
	now: Date;
	state: MemoryMaintenanceState;
	maintenance: PipiclawMemoryMaintenanceSettings;
	channelActive: boolean;
	hasNewEntry: boolean;
	hasMeaningfulExchange: boolean;
	batchSize: number;
	minBatchSize?: number;
	coveredByGrowthReview?: boolean;
}

export interface GrowthReviewGateInput {
	now: Date;
	state: MemoryMaintenanceState;
	memoryGrowth: PipiclawMemoryGrowthSettings;
	maintenance: PipiclawMemoryMaintenanceSettings;
	channelActive: boolean;
	hasNewEntry: boolean;
	hasMeaningfulMaterial: boolean;
	hasPromotionSignal: boolean;
}

export interface StructuralMaintenanceGateInput {
	now: Date;
	state: MemoryMaintenanceState;
	maintenance: PipiclawMemoryMaintenanceSettings;
	channelActive: boolean;
	memoryCleanupNeeded: boolean;
	historyFoldingNeeded: boolean;
	hasMemoryContent: boolean;
	hasHistoryContent: boolean;
}

export interface StructuralMaintenanceGateDecision extends MaintenanceGateDecision {
	runMemoryCleanup: boolean;
	runHistoryFolding: boolean;
}

function deny(jobKind: MaintenanceJobKind, skipReason: string): MaintenanceGateDecision {
	return { allowed: false, jobKind, skipReason };
}

function allow(jobKind: MaintenanceJobKind): MaintenanceGateDecision {
	return { allowed: true, jobKind };
}

function parseTime(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const time = Date.parse(value);
	return Number.isFinite(time) ? time : null;
}

function isBeforeOptional(now: Date, value: string | undefined | null): boolean {
	const time = parseTime(value ?? undefined);
	return time !== null && now.getTime() < time;
}

function hasIntervalElapsed(now: Date, lastRunAt: string | undefined, intervalMs: number): boolean {
	const lastRunTime = parseTime(lastRunAt);
	return lastRunTime === null || now.getTime() - lastRunTime >= intervalMs;
}

function minutesToMs(minutes: number): number {
	return Math.max(0, minutes) * 60_000;
}

function hoursToMs(hours: number): number {
	return Math.max(0, hours) * 3_600_000;
}

function sessionRefreshThresholdMet(state: MemoryMaintenanceState, settings: PipiclawSessionMemorySettings): boolean {
	return (
		state.turnsSinceSessionRefresh >= settings.minTurnsBetweenUpdate ||
		state.toolCallsSinceSessionRefresh >= settings.minToolCallsBetweenUpdate
	);
}

function growthReviewThresholdMet(state: MemoryMaintenanceState, settings: PipiclawMemoryGrowthSettings): boolean {
	return (
		state.turnsSinceGrowthReview >= settings.minTurnsBetweenReview ||
		state.toolCallsSinceGrowthReview >= settings.minToolCallsBetweenReview
	);
}

export function shouldRunSessionRefresh(input: SessionRefreshGateInput): MaintenanceGateDecision {
	if (!input.sessionMemory.enabled) {
		return deny("session-refresh", "disabled");
	}
	if (!input.state.dirty) {
		return deny("session-refresh", "clean");
	}
	if (isBeforeOptional(input.now, input.state.eligibleAfter)) {
		return deny("session-refresh", "not-idle-yet");
	}
	if (input.channelActive) {
		return deny("session-refresh", "channel-active");
	}
	if (isBeforeOptional(input.now, input.state.failureBackoffUntil)) {
		return deny("session-refresh", "backoff-active");
	}
	if (
		!hasIntervalElapsed(
			input.now,
			input.state.lastSessionRefreshAt,
			minutesToMs(input.maintenance.sessionRefreshIntervalMinutes),
		)
	) {
		return deny("session-refresh", "interval-not-elapsed");
	}
	if (!sessionRefreshThresholdMet(input.state, input.sessionMemory)) {
		return deny("session-refresh", "threshold-not-met");
	}
	if (!input.hasNewSessionEntry) {
		return deny("session-refresh", "no-new-session-entry");
	}
	if (!input.hasMeaningfulMaterial) {
		return deny("session-refresh", "no-meaningful-material");
	}
	return allow("session-refresh");
}

export function shouldRunDurableConsolidation(input: DurableConsolidationGateInput): MaintenanceGateDecision {
	if (!input.state.dirty) {
		return deny("durable-consolidation", "clean");
	}
	if (isBeforeOptional(input.now, input.state.eligibleAfter)) {
		return deny("durable-consolidation", "not-idle-yet");
	}
	if (input.channelActive) {
		return deny("durable-consolidation", "channel-active");
	}
	if (
		!hasIntervalElapsed(
			input.now,
			input.state.lastDurableConsolidationAt,
			minutesToMs(input.maintenance.durableConsolidationIntervalMinutes),
		)
	) {
		return deny("durable-consolidation", "interval-not-elapsed");
	}
	if (isBeforeOptional(input.now, input.state.failureBackoffUntil)) {
		return deny("durable-consolidation", "backoff-active");
	}
	if (!input.hasNewEntry) {
		return deny("durable-consolidation", "no-new-entry");
	}
	if (!input.hasMeaningfulExchange) {
		return deny("durable-consolidation", "no-meaningful-exchange");
	}
	if (input.coveredByGrowthReview) {
		return deny("durable-consolidation", "covered-by-growth-review");
	}
	if (input.batchSize < (input.minBatchSize ?? 2)) {
		return deny("durable-consolidation", "batch-threshold-not-met");
	}
	return allow("durable-consolidation");
}

export function shouldRunGrowthReview(input: GrowthReviewGateInput): MaintenanceGateDecision {
	if (!input.memoryGrowth.postTurnReviewEnabled) {
		return deny("growth-review", "disabled");
	}
	if (!input.state.dirty) {
		return deny("growth-review", "clean");
	}
	if (isBeforeOptional(input.now, input.state.eligibleAfter)) {
		return deny("growth-review", "not-idle-yet");
	}
	if (input.channelActive) {
		return deny("growth-review", "channel-active");
	}
	if (
		!hasIntervalElapsed(
			input.now,
			input.state.lastGrowthReviewAt,
			minutesToMs(input.maintenance.growthReviewIntervalMinutes),
		)
	) {
		return deny("growth-review", "interval-not-elapsed");
	}
	if (isBeforeOptional(input.now, input.state.failureBackoffUntil)) {
		return deny("growth-review", "backoff-active");
	}
	if (!growthReviewThresholdMet(input.state, input.memoryGrowth)) {
		return deny("growth-review", "threshold-not-met");
	}
	if (!input.hasNewEntry) {
		return deny("growth-review", "no-new-entry");
	}
	if (!input.hasMeaningfulMaterial) {
		return deny("growth-review", "no-meaningful-material");
	}
	if (!input.hasPromotionSignal) {
		return deny("growth-review", "no-promotion-signal");
	}
	return allow("growth-review");
}

export function shouldRunStructuralMaintenance(
	input: StructuralMaintenanceGateInput,
): StructuralMaintenanceGateDecision {
	const jobKind = "structural-maintenance";
	const denyStructural = (skipReason: string): StructuralMaintenanceGateDecision => ({
		allowed: false,
		jobKind,
		skipReason,
		runMemoryCleanup: false,
		runHistoryFolding: false,
	});

	if (input.channelActive) {
		return denyStructural("channel-active");
	}
	if (
		!hasIntervalElapsed(
			input.now,
			input.state.lastStructuralMaintenanceAt,
			hoursToMs(input.maintenance.structuralMaintenanceIntervalHours),
		)
	) {
		return denyStructural("interval-not-elapsed");
	}
	if (isBeforeOptional(input.now, input.state.failureBackoffUntil)) {
		return denyStructural("backoff-active");
	}
	if (!input.hasMemoryContent && !input.hasHistoryContent) {
		return denyStructural("empty-template-files");
	}

	const runMemoryCleanup = input.memoryCleanupNeeded;
	const runHistoryFolding = input.historyFoldingNeeded;
	if (!runMemoryCleanup && !runHistoryFolding) {
		return denyStructural("nothing-to-maintain");
	}

	return {
		allowed: true,
		jobKind,
		runMemoryCleanup,
		runHistoryFolding,
	};
}
