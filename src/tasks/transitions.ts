import { RecoverableToolError } from "../shared/recoverable-error.js";
/**
 * The task status model and its single transition table (spec 029, D3).
 *
 * There are six canonical statuses. Every status maps to exactly one driver behaviour;
 * statuses that used to differ only for human readers were merged (their nuance now lives
 * in free-text `control.blockedReason`). A single `action × fromStatus → toStatus` table
 * replaces the per-action status guards that used to be scattered across `task_manage` and
 * the `/tasks` command handlers, so an illegal transition always fails the same way.
 *
 *   active     → dispatchable now (wake-gated: not yet due ⇒ sleep until wake)
 *   waiting    → sleep until wake, then dispatch
 *   verifying  → dispatch a checker-only turn
 *   paused     → never dispatched (excluded at the driver scan layer, zero token)
 *   done       → recurring: reopen next cycle at wake; otherwise archived
 *   cancelled  → archived, never
 */

export const TASK_STATUSES = ["active", "waiting", "verifying", "done", "cancelled", "paused"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a user/agent may set directly via create/progress/set. */
export const SETTABLE_TASK_STATUSES = ["active", "waiting", "paused"] as const;
export type SettableTaskStatus = (typeof SETTABLE_TASK_STATUSES)[number];

/** Statuses the driver never dispatches. */
export const TERMINAL_TASK_STATUSES = new Set<string>(["done", "cancelled", "paused"]);

export type TaskLifecycleAction =
	| "create"
	| "progress"
	| "candidate"
	| "verify"
	| "done"
	| "skip"
	| "cancel"
	| "set"
	| "pause"
	| "resume"
	| "run";

interface TransitionRule {
	/** Statuses the action may be invoked from. `create` starts from nothing. */
	from: readonly TaskStatus[];
	/** A fixed target status, or "caller" when the request supplies a settable status. */
	to: TaskStatus | "caller";
}

const TRANSITIONS: Record<TaskLifecycleAction, TransitionRule> = {
	create: { from: [], to: "active" },
	progress: { from: ["active", "waiting", "verifying"], to: "caller" },
	candidate: { from: ["active", "waiting"], to: "verifying" },
	verify: { from: ["verifying"], to: "verifying" },
	done: { from: ["active", "waiting", "verifying"], to: "done" },
	skip: { from: ["active", "waiting", "verifying"], to: "done" },
	cancel: { from: ["active", "waiting", "verifying", "paused"], to: "cancelled" },
	set: { from: ["active", "waiting", "verifying", "paused", "done"], to: "caller" },
	pause: { from: ["active", "waiting", "verifying"], to: "paused" },
	resume: { from: ["paused"], to: "active" },
	run: { from: ["paused", "active", "waiting"], to: "active" },
};

/**
 * Map a stored (possibly legacy) status string to a canonical status.
 * Legacy files are read losslessly and written back canonical on the next write;
 * there is no disk migration. `escalated` maps to `paused` — the caller is expected to
 * stamp `control.pausedBy = "governor"` to preserve the "stopped by the governor" nuance.
 */
export function normalizeStoredStatus(raw: string | undefined): TaskStatus {
	switch (raw) {
		case undefined:
		case "":
		case "open":
		case "in-progress":
			return "active";
		case "awaiting-user":
		case "blocked":
			return "waiting";
		case "escalated":
			return "paused";
		default:
			return (TASK_STATUSES as readonly string[]).includes(raw) ? (raw as TaskStatus) : "active";
	}
}

/** True when the stored status was the legacy `escalated` (⇒ paused by the governor). */
export function wasLegacyEscalated(raw: string | undefined): boolean {
	return raw === "escalated";
}

export function isSettableTaskStatus(value: string): value is SettableTaskStatus {
	return (SETTABLE_TASK_STATUSES as readonly string[]).includes(value);
}

/**
 * Assert an action is legal from the current status, throwing a uniform error otherwise.
 * Returns the resolved target status: a fixed status, or — for `to: "caller"` actions —
 * `requestedStatus` when supplied (validated as settable) else the unchanged `from`.
 */
export function resolveTaskTransition(
	action: TaskLifecycleAction,
	id: string,
	from: TaskStatus,
	requestedStatus?: string,
): TaskStatus {
	const rule = TRANSITIONS[action];
	if (!rule.from.includes(from)) {
		throw new RecoverableToolError(
			`Task ${id} is ${from}; action ${action} allows only from: ${rule.from.join(", ") || "(none)"}.`,
		);
	}
	if (rule.to !== "caller") return rule.to;
	if (requestedStatus === undefined) return from;
	if (!isSettableTaskStatus(requestedStatus)) {
		throw new RecoverableToolError(
			`Invalid status "${requestedStatus}". Use one of ${SETTABLE_TASK_STATUSES.join(", ")}.`,
		);
	}
	return requestedStatus;
}
