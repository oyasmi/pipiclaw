import type { PipiclawMemoryMaintenanceSettings } from "../settings.js";
import { parseLocalTime } from "../shared/local-time.js";
import type { MemoryMaintenanceState } from "./maintenance-state.js";

/** Spec 050, D9: the three v1 jobs collapse to one. */
export type MaintenanceJobKind = "reflect";

export interface MaintenanceGateDecision {
	allowed: boolean;
	skipReason?: string;
	jobKind: MaintenanceJobKind;
}

export interface ReflectMaterial {
	hasNewEntry: boolean;
	hasMeaningfulExchange: boolean;
}

/**
 * Material checks are passed as a thunk, never as a value: every cheap check below (settings,
 * timestamps, idle/backoff windows) runs before the material — which means building the
 * incremental source window and scanning the transcript — is ever paid for. That is what keeps
 * an idle daemon's steady-state tick to one state-file read plus timestamp arithmetic.
 */
export interface ReflectGateInput {
	now: Date;
	state: MemoryMaintenanceState;
	maintenance: PipiclawMemoryMaintenanceSettings;
	channelActive: boolean;
	material: () => ReflectMaterial;
}

function deny(skipReason: string): MaintenanceGateDecision {
	return { allowed: false, jobKind: "reflect", skipReason };
}

const allow: MaintenanceGateDecision = { allowed: true, jobKind: "reflect" };

function parseTime(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const time = parseLocalTime(value);
	return time === undefined ? null : time;
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

export function shouldRunReflect(input: ReflectGateInput): MaintenanceGateDecision {
	if (!input.state.dirty) {
		return deny("clean");
	}
	if (isBeforeOptional(input.now, input.state.eligibleAfter)) {
		return deny("not-idle-yet");
	}
	if (input.channelActive) {
		return deny("channel-active");
	}
	if (isBeforeOptional(input.now, input.state.failureBackoffUntil)) {
		return deny("backoff-active");
	}
	if (
		!hasIntervalElapsed(input.now, input.state.lastReflectAt, minutesToMs(input.maintenance.reflectIntervalMinutes))
	) {
		return deny("interval-not-elapsed");
	}
	const material = input.material();
	if (!material.hasNewEntry) {
		return deny("no-new-entry");
	}
	if (!material.hasMeaningfulExchange) {
		return deny("no-meaningful-exchange");
	}
	return allow;
}
