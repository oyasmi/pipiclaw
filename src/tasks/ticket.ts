import { formatLocalTime, parseLocalTime, parseWakeInput } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { isPlainObject } from "../shared/type-guards.js";
import { nextTaskWake } from "./task-schedule.js";

/**
 * The waiting ticket (spec 051, D2) — the only way a task may park.
 *
 * Spec 050-era `waiting` carried a `waitingFor` enum whose own doc comment said it was
 * "diagnostic display only; it does not gate wake activation". The single field describing what a
 * task was waiting for was, by design, unrelated to whether that wait could ever end — and both
 * of the real long-lived tasks on the author's machine died of exactly that: parked with no
 * redeemable source, silent for 9 and 13 days respectively while the governor watched for tasks
 * that spun too much.
 *
 * A ticket fixes that by being a claim the runtime can check at write time (the run exists, is
 * unsettled, and names this task) and, crucially, by always carrying `by` — a backstop instant
 * after which the runtime reopens the task rather than leaving it parked forever. That is
 * D2-INV: a parked task either gets redeemed, or the user hears about it.
 */
export type TicketKind = "time" | "schedule" | "run" | "job" | "ask" | "signal";

export type Ticket =
	| { kind: "time"; at: string; by: string }
	| { kind: "schedule"; at: string; by: string }
	| { kind: "run"; id: string; by: string }
	| { kind: "job"; id: string; by: string }
	| { kind: "ask"; asked: string; by: string }
	| { kind: "signal"; event: string; by: string };

/** The minimum a ticket resolver needs to know about a delegation run. */
export interface TicketRunRef {
	taskId?: string;
	settledAt?: number;
	startedAt: number;
	deadlineAt?: number;
	maxWallTimeSec?: number;
}

/** The minimum a ticket resolver needs to know about a background job. */
export interface TicketJobRef {
	taskId?: string;
	status: string;
	startedAt: number;
}

/** The minimum a ticket resolver needs to know about a scheduled event. */
export interface TicketEventRef {
	type: "one-shot" | "periodic";
	channelId: string;
	schedule?: string;
}

/**
 * Everything `resolveTicket` may consult, injected rather than imported: the run/job/event
 * registries are stateful singletons, and keeping them out of this module is what makes the whole
 * validation matrix unit-testable without a runtime.
 */
export interface TicketContext {
	now: Date;
	taskId: string;
	channelId: string;
	/** The task's own cron cadence; required for a `schedule` ticket. */
	schedule?: string;
	findRun(id: string): TicketRunRef | undefined;
	findJob(id: string): TicketJobRef | undefined;
	findEvent(name: string): TicketEventRef | undefined;
}

const TICKET_KINDS: readonly TicketKind[] = ["time", "schedule", "run", "job", "ask", "signal"];

/** A ticket the runtime cannot pin to a real occurrence still gets a backstop this far out. */
const DEFAULT_BACKSTOP_MS = 24 * 60 * 60 * 1000;
/** Slack added to a run's own wall-clock deadline before the task gives up on it. */
const RUN_BACKSTOP_SLACK_MS = 10 * 60 * 1000;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new RecoverableToolError(`ticket.${field} is required and must be a non-empty string.`);
	}
	return value.trim();
}

/**
 * The interval between the next two occurrences of `cron` after `from`, or `undefined` when the
 * cron does not fire at least twice. Used to express backstops as "one/two missed occurrences"
 * rather than a fixed wall-clock guess, so a 30-minute sensor and a monthly job get proportionate
 * patience from the same rule.
 */
function occurrenceInterval(cron: string, from: Date): { first: Date; intervalMs: number } | undefined {
	const first = nextTaskWake(cron, from);
	if (!first) return undefined;
	const second = nextTaskWake(cron, first);
	if (!second) return { first, intervalMs: DEFAULT_BACKSTOP_MS };
	return { first, intervalMs: second.getTime() - first.getTime() };
}

function scheduleBackstop(cron: string, now: Date, missedOccurrences: number): string {
	const occurrence = occurrenceInterval(cron, now);
	if (!occurrence) {
		throw new RecoverableToolError(`schedule "${cron}" never fires again; it cannot back a ticket.`);
	}
	return formatLocalTime(new Date(occurrence.first.getTime() + occurrence.intervalMs * missedOccurrences));
}

/**
 * Validate one model-supplied ticket and stamp its backstop.
 *
 * This is the **only** way a `Ticket` value comes into existence — the migrator, `task_step_end`
 * and the `/tasks` commands all funnel through it. Anything that writes the `ticket` frontmatter
 * field directly is a defect: it would produce a park with no verified source or no `by`, which
 * is precisely the failure this whole mechanism exists to make impossible.
 */
export function resolveTicket(input: unknown, ctx: TicketContext): Ticket {
	if (!isPlainObject(input)) {
		throw new RecoverableToolError(`ticket must be an object with a "kind" of: ${TICKET_KINDS.join(", ")}.`);
	}
	const kind = input.kind;
	if (typeof kind !== "string" || !(TICKET_KINDS as readonly string[]).includes(kind)) {
		throw new RecoverableToolError(`Unknown ticket kind "${String(kind)}". Use one of: ${TICKET_KINDS.join(", ")}.`);
	}
	const nowMs = ctx.now.getTime();

	switch (kind as TicketKind) {
		case "time": {
			const raw = requiredString(input.at, "at");
			const atMs = parseWakeInput(raw, ctx.now);
			if (atMs === undefined) {
				throw new RecoverableToolError(
					`ticket.at "${raw}" is not a valid local time or relative offset (e.g. 2026-09-06T09:00:00+08:00, +2h).`,
				);
			}
			if (atMs <= nowMs) {
				throw new RecoverableToolError(
					`ticket.at "${raw}" is not in the future; a time ticket must wait for something.`,
				);
			}
			const at = formatLocalTime(new Date(atMs));
			return { kind: "time", at, by: at };
		}
		case "schedule": {
			if (!ctx.schedule) {
				throw new RecoverableToolError(
					"A schedule ticket needs the task to have a `schedule` cron. Set one, or park on a time ticket instead.",
				);
			}
			// The occurrence is stamped, not recomputed on read: a ticket must name a fixed moment,
			// or "is it due yet?" would keep answering "not yet" as the cron rolls forward.
			const occurrence = occurrenceInterval(ctx.schedule, ctx.now);
			if (!occurrence) {
				throw new RecoverableToolError(`schedule "${ctx.schedule}" never fires again; it cannot back a ticket.`);
			}
			return {
				kind: "schedule",
				at: formatLocalTime(occurrence.first),
				by: scheduleBackstop(ctx.schedule, ctx.now, 1),
			};
		}
		case "run": {
			const id = requiredString(input.id, "id");
			const run = ctx.findRun(id);
			if (!run) {
				throw new RecoverableToolError(
					`No run "${id}" in this channel. Use subagent_list to find the right id, or park on a different ticket.`,
				);
			}
			if (run.settledAt !== undefined) {
				throw new RecoverableToolError(
					`Run ${id} already settled; read its result and continue instead of parking on it.`,
				);
			}
			if (run.taskId !== ctx.taskId) {
				throw new RecoverableToolError(
					`Run ${id} belongs to task ${run.taskId ?? "(none)"}; it will never wake this task. Dispatch with taskId=${ctx.taskId}.`,
				);
			}
			const deadline =
				run.deadlineAt ?? (run.maxWallTimeSec ? run.startedAt + run.maxWallTimeSec * 1000 : undefined);
			const by = (deadline ?? run.startedAt + DEFAULT_BACKSTOP_MS) + RUN_BACKSTOP_SLACK_MS;
			return { kind: "run", id, by: formatLocalTime(new Date(by)) };
		}
		case "job": {
			const id = requiredString(input.id, "id");
			const job = ctx.findJob(id);
			if (!job) {
				throw new RecoverableToolError(
					`No job "${id}" in this channel. Use job op=list to find the right id, or park on a different ticket.`,
				);
			}
			if (job.status !== "running") {
				throw new RecoverableToolError(
					`Job ${id} is ${job.status}; read its output and continue instead of parking on it.`,
				);
			}
			if (job.taskId !== ctx.taskId) {
				throw new RecoverableToolError(
					`Job ${id} belongs to task ${job.taskId ?? "(none)"}; it will never wake this task. Relaunch it with taskId=${ctx.taskId}.`,
				);
			}
			return { kind: "job", id, by: formatLocalTime(new Date(job.startedAt + DEFAULT_BACKSTOP_MS)) };
		}
		case "ask": {
			const asked = requiredString(input.asked, "asked");
			return { kind: "ask", asked, by: formatLocalTime(new Date(nowMs + DEFAULT_BACKSTOP_MS)) };
		}
		case "signal": {
			const name = requiredString(input.event, "event");
			const event = ctx.findEvent(name);
			if (!event) {
				throw new RecoverableToolError(
					`No event "${name}" in this workspace. Create it with event_manage first, or park on a time ticket.`,
				);
			}
			if (event.channelId !== ctx.channelId) {
				throw new RecoverableToolError(`Event "${name}" belongs to another channel; it cannot wake this task.`);
			}
			if (event.type !== "periodic" || !event.schedule) {
				throw new RecoverableToolError(
					`Event "${name}" is one-shot; a sensor must be periodic. Use a time ticket instead.`,
				);
			}
			// The event must name this task: a signal ticket is redeemed by the events watcher on a
			// pure name match, so accepting an unrelated event's name here would create a park that
			// nothing can ever redeem (INV-7's write-side half).
			const expectedPrefix = `task.${ctx.channelId}.${ctx.taskId}.`;
			if (!name.startsWith(expectedPrefix)) {
				throw new RecoverableToolError(
					`Event "${name}" does not belong to this task; a signal ticket needs an event named ${expectedPrefix}<use>.`,
				);
			}
			return { kind: "signal", event: name, by: scheduleBackstop(event.schedule, ctx.now, 2) };
		}
	}
}

/** Read a persisted ticket back. Returns `undefined` for anything not shaped like a v4 ticket. */
export function parseTicket(raw: string): Ticket | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isPlainObject(value)) return undefined;
	const kind = value.kind;
	const by = typeof value.by === "string" ? value.by.trim() : "";
	if (typeof kind !== "string" || !(TICKET_KINDS as readonly string[]).includes(kind) || !by) return undefined;
	if (parseLocalTime(by) === undefined) return undefined;
	switch (kind as TicketKind) {
		case "time":
			return typeof value.at === "string" && value.at ? { kind: "time", at: value.at, by } : undefined;
		case "schedule":
			return typeof value.at === "string" && value.at ? { kind: "schedule", at: value.at, by } : undefined;
		case "run":
			return typeof value.id === "string" && value.id ? { kind: "run", id: value.id, by } : undefined;
		case "job":
			return typeof value.id === "string" && value.id ? { kind: "job", id: value.id, by } : undefined;
		case "ask":
			return typeof value.asked === "string" && value.asked ? { kind: "ask", asked: value.asked, by } : undefined;
		case "signal":
			return typeof value.event === "string" && value.event ? { kind: "signal", event: value.event, by } : undefined;
	}
}

/** Milliseconds of the ticket's backstop, or `undefined` when it is unparseable (never trusted). */
export function ticketBackstopMs(ticket: Ticket): number | undefined {
	return parseLocalTime(ticket.by);
}

/**
 * Whether this ticket's backstop has passed. An unparseable `by` counts as expired: a park whose
 * deadline cannot be read is exactly the silent-forever state D2-INV forbids, so it fails toward
 * waking the task rather than toward leaving it buried.
 */
export function ticketExpired(ticket: Ticket, now: Date = new Date()): boolean {
	const by = ticketBackstopMs(ticket);
	return by === undefined || by <= now.getTime();
}

/**
 * The moment a `time` ticket is *due* (as opposed to its backstop). Only `time` and `schedule`
 * tickets are driver-polled; every other kind is pushed by its owner, so they have no due time.
 */
export function ticketDueMs(ticket: Ticket): number | undefined {
	return ticket.kind === "time" || ticket.kind === "schedule" ? parseLocalTime(ticket.at) : undefined;
}

/** One-line summary for `/tasks`, receipts, and the step brief. */
export function describeTicket(ticket: Ticket): string {
	switch (ticket.kind) {
		case "time":
			return `等待时间 ${ticket.at}`;
		case "schedule":
			return `等待下一次计划唤醒 ${ticket.at}`;
		case "run":
			return `等待委派 ${ticket.id}`;
		case "job":
			return `等待作业 ${ticket.id}`;
		case "ask":
			return `等待用户回答：${ticket.asked}`;
		case "signal":
			return `等待事件 ${ticket.event}`;
	}
}
