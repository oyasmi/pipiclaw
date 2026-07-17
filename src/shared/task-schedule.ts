import { Cron } from "croner";
import { errorMessage } from "./text-utils.js";

/**
 * The cron cadence of a recurring task lives in its `schedule` frontmatter key.
 * Cron is always interpreted in the host timezone — tasks (and events) follow the
 * person on their machine, so no `timezone` field or config exists.
 */

/** A task schedule may fire no more often than this (anti-self-nudge floor). */
export const MIN_TASK_SCHEDULE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Validate a task `schedule` cron: it must parse (host timezone) and fire no more
 * often than every 30 minutes. Throws with an agent-readable message otherwise.
 * Mirrors the `event_manage` periodic gate so both write paths reject the same cron.
 */
export function validateTaskSchedule(schedule: string): void {
	let runs: Date[];
	try {
		const cron = new Cron(schedule);
		runs = cron.nextRuns(3);
		cron.stop();
	} catch (error) {
		throw new Error(`schedule "${schedule}" is not a valid cron: ${errorMessage(error)}`);
	}
	if (runs.length === 0) {
		throw new Error(`schedule "${schedule}" never fires; use a valid five-field cron.`);
	}
	const floorMinutes = Math.round(MIN_TASK_SCHEDULE_INTERVAL_MS / 60_000);
	// Fewer than two upcoming runs means no cadence to rate-limit (e.g. a one-off cron); allow it.
	for (let i = 1; i < runs.length; i++) {
		if (runs[i].getTime() - runs[i - 1].getTime() < MIN_TASK_SCHEDULE_INTERVAL_MS) {
			throw new Error(`schedule "${schedule}" must fire no more often than every ${floorMinutes} minutes.`);
		}
	}
}

/**
 * Next occurrence of a task `schedule` strictly after `from`, or undefined when the
 * cron cannot be parsed (the caller decides how to surface that).
 */
export function nextTaskWake(schedule: string, from: Date = new Date()): Date | undefined {
	try {
		const cron = new Cron(schedule);
		const next = cron.nextRun(from);
		cron.stop();
		return next ?? undefined;
	} catch {
		return undefined;
	}
}
