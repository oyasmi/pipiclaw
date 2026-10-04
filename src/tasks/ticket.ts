import { formatLocalTime, parseLocalTime, parseWakeInput } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { isPlainObject } from "../shared/type-guards.js";

/**
 * The waiting ticket — the only way a task may park (spec 051, D2; narrowed by spec 052, D3).
 *
 * A ticket is a claim the runtime can check at write time, and it always carries `by`, a backstop
 * instant after which the runtime reopens the task rather than leaving it parked forever: a
 * parked task either gets redeemed, or the user hears about it. Three kinds are enough:
 *
 * - `time` — wait for a moment; the driver redeems it.
 * - `work` — wait for the delegations and jobs this task has in flight; the first one to settle
 *   redeems it. The leader never has to pick "which run is the real blocker".
 * - `ask` — wait for the user; `/tasks reply` redeems it.
 *
 * Waiting for an external condition is a background job (a sensor with a timeout) bound to the
 * task, i.e. a `work` ticket — not a separate kind.
 */
export type TicketKind = "time" | "work" | "ask";

export type Ticket =
	| { kind: "time"; at: string; by: string }
	/** `refs` is display-only: redemption matches on `kind`, never on the ids. */
	| { kind: "work"; refs: string[]; by: string }
	| { kind: "ask"; asked: string; by: string };

/** A delegation or background job bound to this task that has not settled yet. */
export interface PendingWorkRef {
	ref: string;
	/** Epoch ms after which the owner itself gives up on the work. */
	deadlineMs: number;
}

/**
 * Everything `resolveTicket` may consult, injected rather than imported: the run/job registries
 * are stateful singletons, and keeping them out of this module is what makes the whole
 * validation matrix unit-testable without a runtime.
 */
export interface TicketContext {
	now: Date;
	/** Unsettled runs and still-running jobs whose `taskId` is this task. */
	pendingWork(): PendingWorkRef[];
}

const TICKET_KINDS: readonly TicketKind[] = ["time", "work", "ask"];

/** `ask` has no source that could report back on its own, so it gets a generous fixed backstop. */
const ASK_BACKSTOP_MS = 24 * 60 * 60 * 1000;
/** Slack added to the latest pending deadline before the task gives up on the work. */
const WORK_BACKSTOP_SLACK_MS = 10 * 60 * 1000;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new RecoverableToolError(`ticket.${field} is required and must be a non-empty string.`);
	}
	return value.trim();
}

/**
 * Validate one model-supplied ticket and stamp its backstop.
 *
 * This is the **only** way a `Ticket` value comes into existence — `task_step_end`, `/tasks
 * reply` and the converter all funnel through it. Anything that writes the `ticket` frontmatter
 * field directly is a defect: it would produce a park with no verified source or no `by`.
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
		case "work": {
			const pending = ctx.pendingWork();
			if (pending.length === 0) {
				throw new RecoverableToolError(
					"This task has no delegation or background job in flight, so a work ticket has nothing to wait for. " +
						"Every result so far is already on the <task_board>: read it and continue, or dispatch more work first (with the task bound).",
				);
			}
			const latest = Math.max(...pending.map((item) => item.deadlineMs));
			return {
				kind: "work",
				refs: pending.map((item) => item.ref),
				by: formatLocalTime(new Date(latest + WORK_BACKSTOP_SLACK_MS)),
			};
		}
		case "ask": {
			const asked = requiredString(input.asked, "asked");
			return { kind: "ask", asked, by: formatLocalTime(new Date(nowMs + ASK_BACKSTOP_MS)) };
		}
	}
}

/** Read a persisted ticket back. Returns `undefined` for anything not shaped like a ticket. */
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
		case "work": {
			const refs = Array.isArray(value.refs)
				? value.refs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
				: [];
			return { kind: "work", refs, by };
		}
		case "ask":
			return typeof value.asked === "string" && value.asked ? { kind: "ask", asked: value.asked, by } : undefined;
	}
}

/** Milliseconds of the ticket's backstop, or `undefined` when it is unparseable (never trusted). */
export function ticketBackstopMs(ticket: Ticket): number | undefined {
	return parseLocalTime(ticket.by);
}

/**
 * Whether this ticket's backstop has passed. An unparseable `by` counts as expired: a park whose
 * deadline cannot be read is exactly the silent-forever state the backstop forbids, so it fails
 * toward waking the task rather than toward leaving it buried.
 */
export function ticketExpired(ticket: Ticket, now: Date = new Date()): boolean {
	const by = ticketBackstopMs(ticket);
	return by === undefined || by <= now.getTime();
}

/** The moment a `time` ticket is *due*. Only `time` tickets are driver-polled; the rest are pushed by their owner. */
export function ticketDueMs(ticket: Ticket): number | undefined {
	return ticket.kind === "time" ? parseLocalTime(ticket.at) : undefined;
}

/** One-line summary for `/tasks`, receipts, and the step brief. */
export function describeTicket(ticket: Ticket): string {
	switch (ticket.kind) {
		case "time":
			return `等待时间 ${ticket.at}`;
		case "work":
			return ticket.refs.length > 0 ? `等待委派/作业 ${ticket.refs.join(", ")}` : "等待委派/作业";
		case "ask":
			return `等待用户回答：${ticket.asked}`;
	}
}
