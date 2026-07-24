import type { PipiclawMemoryMaintenanceSettings, PipiclawSessionMemorySettings } from "../settings.js";
import type { MemoryMaintenanceState } from "./maintenance-state.js";

export type MaintenanceJobKind = "session-refresh" | "memory-checkpoint" | "structural-maintenance";

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

export interface MemoryCheckpointGateInput {
	now: Date;
	state: MemoryMaintenanceState;
	maintenance: PipiclawMemoryMaintenanceSettings;
	channelActive: boolean;
	hasNewEntry: boolean;
	hasMeaningfulExchange: boolean;
	batchSize: number;
	minBatchSize?: number;
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

export function shouldRunMemoryCheckpoint(input: MemoryCheckpointGateInput): MaintenanceGateDecision {
	if (!input.state.dirty) {
		return deny("memory-checkpoint", "clean");
	}
	if (isBeforeOptional(input.now, input.state.eligibleAfter)) {
		return deny("memory-checkpoint", "not-idle-yet");
	}
	if (input.channelActive) {
		return deny("memory-checkpoint", "channel-active");
	}
	if (
		!hasIntervalElapsed(
			input.now,
			input.state.lastCheckpointAt,
			minutesToMs(input.maintenance.checkpointIntervalMinutes),
		)
	) {
		return deny("memory-checkpoint", "interval-not-elapsed");
	}
	if (isBeforeOptional(input.now, input.state.failureBackoffUntil)) {
		return deny("memory-checkpoint", "backoff-active");
	}
	if (!input.hasNewEntry) {
		return deny("memory-checkpoint", "no-new-entry");
	}
	if (!input.hasMeaningfulExchange) {
		return deny("memory-checkpoint", "no-meaningful-exchange");
	}
	if (input.batchSize < (input.minBatchSize ?? 2)) {
		return deny("memory-checkpoint", "batch-threshold-not-met");
	}
	return allow("memory-checkpoint");
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
