import { RecoverableToolError } from "../shared/recoverable-error.js";

/** The only lifecycle stages stored in an active task directory. */
export const TASK_STATUSES = ["active", "waiting", "sleeping"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a model/user may set directly; recurring sleeping is runtime-owned but repairable. */
export const SETTABLE_TASK_STATUSES = ["active", "waiting", "sleeping"] as const;
export type SettableTaskStatus = (typeof SETTABLE_TASK_STATUSES)[number];

export type TaskLifecycleAction =
	| "create"
	| "progress"
	| "verify"
	| "complete"
	| "skip"
	| "cancel"
	| "set"
	| "pause"
	| "resume"
	| "run"
	| "governor-stop"
	| "wait-due"
	| "cycle-due";

interface TransitionRule {
	from: readonly TaskStatus[];
	/** The operation chooses its final archive/sleeping result outside the live status graph. */
	to: TaskStatus | "caller";
}

const LIVE = ["active", "waiting", "sleeping"] as const;
const WORKABLE = ["active", "waiting"] as const;

const TRANSITIONS: Record<TaskLifecycleAction, TransitionRule> = {
	create: { from: [], to: "active" },
	progress: { from: WORKABLE, to: "caller" },
	// Not gated on a specific waitingFor value: the wake that reactivates a task parked for a
	// purpose=verify sub-agent already flips it to active before this runs (the same as any other
	// delegation wake), but `verify` also accepts waiting so it is not sensitive to exactly when
	// that reactivation lands relative to the model's own turn.
	verify: { from: WORKABLE, to: "active" },
	complete: { from: ["active"], to: "caller" },
	skip: { from: WORKABLE, to: "sleeping" },
	cancel: { from: LIVE, to: "caller" },
	set: { from: LIVE, to: "caller" },
	pause: { from: LIVE, to: "caller" },
	resume: { from: LIVE, to: "caller" },
	run: { from: LIVE, to: "active" },
	"governor-stop": { from: LIVE, to: "caller" },
	"wait-due": { from: ["waiting"], to: "active" },
	"cycle-due": { from: ["sleeping"], to: "active" },
};

/** Canonicalize a stored status value, fail-open to `active` for anything not in the current vocabulary. */
export function normalizeStoredStatus(raw: string | undefined): TaskStatus {
	return raw !== undefined && (TASK_STATUSES as readonly string[]).includes(raw) ? (raw as TaskStatus) : "active";
}

export function isSettableTaskStatus(value: string): value is SettableTaskStatus {
	return (SETTABLE_TASK_STATUSES as readonly string[]).includes(value);
}

/** Assert an action is legal and resolve caller-supplied target status. */
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
