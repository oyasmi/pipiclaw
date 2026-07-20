import { Cron } from "croner";
import { guardCommand } from "../security/command-guard.js";
import type { SecurityConfig } from "../security/types.js";
import { errorMessage } from "../shared/text-utils.js";
import type { ScheduledEvent } from "./events.js";

/**
 * Admission rules for scheduled events (spec 031, D4).
 *
 * These used to live only in the `event_manage` tool, but the events directory sits inside the
 * agent-writable workspace, so a plain `write` bypassed every one of them — the self-triggering
 * guard was advisory rather than enforced. The rules therefore live here and are applied by
 * both the tool (fail early, with a recoverable message) and `EventsWatcher` (the actual trust
 * boundary, which has the final say).
 */

/** one-shot events must be scheduled at least this far out; anything sooner is effectively self-triggering. */
export const MIN_ONE_SHOT_LEAD_MS = 2 * 60 * 1000;
/** periodic events without a preAction gate may fire no more often than this. */
export const MIN_PERIODIC_INTERVAL_MS = 30 * 60 * 1000;
/**
 * periodic events WITH a preAction gate may fire this often: the sensor is the token guard
 * (it exits non-zero and stays silent when there is nothing to do), so a tighter cadence is
 * safe and is exactly the design-endorsed posture for completion-driven checks. A hard
 * sub-floor still applies so a bogus always-pass preAction cannot drive an arbitrarily hot loop.
 */
export const MIN_PERIODIC_INTERVAL_WITH_PREACTION_MS = 5 * 60 * 1000;
/** sanity cap on total scheduled events to keep the directory (and the scheduler) from being flooded. */
export const MAX_EVENT_FILES = 50;

export class EventValidationError extends Error {
	/** Whether the model can usefully retry with a corrected definition. */
	readonly recoverable: boolean;

	constructor(message: string, recoverable = true) {
		super(message);
		this.name = "EventValidationError";
		this.recoverable = recoverable;
	}
}

export function validateOneShotLead(event: ScheduledEvent & { type: "one-shot" }, now = Date.now()): void {
	const atTime = new Date(event.at).getTime();
	if (!Number.isFinite(atTime)) {
		throw new EventValidationError(`one-shot 'at' is not a valid date: ${event.at}`);
	}
	if (atTime < now + MIN_ONE_SHOT_LEAD_MS) {
		throw new EventValidationError("one-shot 'at' must be at least 2 minutes in the future (self-triggering guard).");
	}
}

export function validatePeriodicCadence(event: ScheduledEvent & { type: "periodic" }): void {
	let runs: Date[];
	try {
		const cron = new Cron(event.schedule);
		runs = cron.nextRuns(3);
		cron.stop();
	} catch (error) {
		throw new EventValidationError(`Invalid cron schedule "${event.schedule}": ${errorMessage(error)}`);
	}
	// A preAction gate makes a tighter cadence safe (the sensor keeps most fires silent);
	// without one, hold the 30-minute floor so a bare high-frequency cron can't burn tokens.
	const floorMs = event.preAction ? MIN_PERIODIC_INTERVAL_WITH_PREACTION_MS : MIN_PERIODIC_INTERVAL_MS;
	const floorMinutes = Math.round(floorMs / 60000);
	// Fewer than two upcoming runs means no meaningful cadence to rate-limit (e.g. a one-off cron); allow it.
	for (let i = 1; i < runs.length; i++) {
		if (runs[i].getTime() - runs[i - 1].getTime() < floorMs) {
			throw new EventValidationError(
				`periodic events must fire no more often than every ${floorMinutes} minutes` +
					`${event.preAction ? " (even with a preAction gate)" : "; for tighter checks add a preAction gate (min 5 minutes) instead of a high-frequency cron"}.`,
			);
		}
	}
}

export function validatePreActionCommand(
	event: ScheduledEvent,
	commandGuardConfig: SecurityConfig["commandGuard"] | undefined,
): void {
	if (!event.preAction || !commandGuardConfig) return;
	const result = guardCommand(event.preAction.command, commandGuardConfig);
	if (!result.allowed) {
		throw new EventValidationError(`preAction command blocked by guard: ${result.reason ?? "not allowed"}`, false);
	}
}

export interface ScheduledEventValidationOptions {
	commandGuardConfig?: SecurityConfig["commandGuard"];
	/**
	 * Whether to enforce the one-shot lead time. It is a *creation-time* rule: a one-shot whose
	 * `at` has already passed is a legitimate post-restart recovery, not a self-trigger, so the
	 * watcher only enforces it for files written while this process was running.
	 */
	enforceOneShotLead?: boolean;
	now?: number;
}

/** Apply every admission rule that depends only on the definition itself. */
export function validateScheduledEvent(event: ScheduledEvent, options: ScheduledEventValidationOptions = {}): void {
	if (event.type === "one-shot" && options.enforceOneShotLead !== false) {
		validateOneShotLead(event, options.now);
	}
	if (event.type === "periodic") {
		validatePeriodicCadence(event);
	}
	validatePreActionCommand(event, options.commandGuardConfig);
}
