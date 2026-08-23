import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";

export type TaskPriority = "low" | "normal" | "high" | "critical";
export type TaskVerificationStatus = "pending" | "passed" | "failed";
/** Diagnostic display only (spec 043); it does not gate wake activation. */
export type TaskWaitingFor = "time" | "user" | "job" | "external-signal";

/**
 * `status` is a display cache only; it never gates `complete` or doctor. Every field that used to
 * mirror the attestation (evidence/bodyHash/checkedAt/subjectHash) is gone — `runId` is enough to
 * re-read the attestation file, which is the sole authority on whether a PASS is real and fresh.
 */
export interface TaskVerification {
	required: boolean;
	status: TaskVerificationStatus;
	runId?: string;
}

export interface TaskStop {
	by: "user" | "governor";
	reason: string;
	at: string;
}

/** The v2 persisted control block. Execution authority comes from capability and scope. */
export interface TaskControl {
	version: 2;
	priority: TaskPriority;
	deadline?: string;
	nextAction?: string;
	waitingFor?: TaskWaitingFor;
	verification: TaskVerification;
	/** Current or most recently closed recurring occurrence. */
	cycleId?: string;
	/** Present only while the task is disabled. */
	stop?: TaskStop;
}

export interface TaskControlPatch {
	priority?: TaskPriority;
	deadline?: string;
	nextAction?: string;
	waitingFor?: TaskWaitingFor;
	verificationRequired?: boolean;
}

export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high", "critical"];
const WAITING_FOR: readonly TaskWaitingFor[] = ["time", "user", "job", "external-signal"];
const VERIFICATION_STATUSES: readonly TaskVerificationStatus[] = ["pending", "passed", "failed"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`control enum value must be one of: ${values.join(", ")}`);
	}
	return value as T;
}

function parseVerificationRequired(verification: Record<string, unknown>): boolean {
	if (typeof verification.required === "boolean") return verification.required;
	// v1's independent mode was the only mode that represented a real checker gate.
	return verification.mode === "independent";
}

function parseStop(value: unknown): TaskStop | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("control.stop must be an object");
	const by = enumValue(value.by, ["user", "governor"] as const, "user");
	const reason = optionalString(value.reason);
	const at = optionalString(value.at);
	if (!reason || !at || parseLocalTime(at) === undefined) {
		throw new Error("control.stop requires a reason and valid at timestamp");
	}
	return { by, reason, at: formatLocalTime(new Date(parseLocalTime(at)!)) };
}

/**
 * Keys from the v1 control block that this version deliberately retires. They remain visible to
 * doctor until the next successful write, but they never enter the v2 control object.
 */
export const RETIRED_TASK_CONTROL_KEYS: readonly string[] = [
	"sideEffects",
	"externalApproval",
	"approvalBy",
	"approvedAt",
	"approvalBodyHash",
	"pausedBy",
	"parent",
	"dependsOn",
	"worktree",
	"lifetimeUsage",
	"isolation",
	"budget.maxTokens",
	"budget.maxCostUsd",
	"budget.maxWallTimeMinutes",
];

/** Retired keys actually present in a raw stored control block. */
export function retiredTaskControlKeys(raw: unknown): string[] {
	if (!isRecord(raw)) return [];
	return RETIRED_TASK_CONTROL_KEYS.filter((key) => {
		const [head, nested] = key.split(".");
		if (!nested) return Object.hasOwn(raw, head);
		const parent = raw[head];
		return isRecord(parent) && Object.hasOwn(parent, nested);
	});
}

export function createDefaultTaskControl(requiresVerification = false): TaskControl {
	return {
		version: 2,
		priority: "normal",
		verification: { required: requiresVerification, status: "pending" },
	};
}

/**
 * Read both v1 and v2 files. Retired v1 policy fields are intentionally ignored; the next
 * write emits a v2 object without them. This is a reader migration, not command compatibility.
 */
export function parseTaskControl(raw: string): TaskControl {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`control is not valid JSON: ${errorMessage(error)}`);
	}
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) {
		throw new Error("control must be a version 1 or version 2 JSON object; repair it with task_manage set.");
	}

	const verification = isRecord(value.verification) ? value.verification : {};
	const deadline = optionalString(value.deadline);
	if (deadline && parseLocalTime(deadline) === undefined) {
		throw new Error("control.deadline must be a valid local time");
	}
	const waitingFor =
		value.waitingFor === undefined ? undefined : enumValue(value.waitingFor, WAITING_FOR, "external-signal");

	let stop = parseStop(value.stop);
	// v1 stored the stop dimension as a status-side `pausedBy` value. Preserve its
	// operational meaning while converting it to the v2 structured record.
	if (!stop && value.pausedBy !== undefined) {
		const by = enumValue(value.pausedBy, ["user", "governor"] as const, "user");
		stop = {
			by,
			reason: optionalString(value.blockedReason) ?? `Task stopped by ${by}.`,
			at: formatLocalTime(),
		};
	}

	return {
		version: 2,
		priority: enumValue(value.priority, TASK_PRIORITIES, "normal"),
		deadline,
		nextAction: optionalString(value.nextAction),
		waitingFor,
		verification: {
			required: parseVerificationRequired(verification),
			status: enumValue(verification.status, VERIFICATION_STATUSES, "pending"),
			runId: optionalString(verification.runId),
		},
		cycleId: optionalString(value.cycleId),
		stop,
	};
}

/** Reset state that is meaningful only within one recurring task cycle. */
export function resetTaskControlForCycle(control: TaskControl, cycleId: string): TaskControl {
	const normalizedCycleId = cycleId.trim();
	if (!normalizedCycleId) throw new Error("cycleId must not be empty.");
	return {
		...structuredClone(control),
		nextAction: undefined,
		waitingFor: undefined,
		verification: { required: control.verification.required, status: "pending" },
		cycleId: normalizedCycleId,
		stop: undefined,
	};
}

function patchOptionalString(current: string | undefined, value: string | undefined): string | undefined {
	if (value === undefined) return current;
	return value.trim() || undefined;
}

export function applyTaskControlPatch(control: TaskControl, patch: TaskControlPatch): TaskControl {
	const next: TaskControl = structuredClone(control);
	if (patch.priority !== undefined) next.priority = patch.priority;
	let normalizedDeadlinePatch = patch.deadline;
	if (patch.deadline?.trim()) {
		const deadlineMs = parseLocalTime(patch.deadline);
		if (deadlineMs === undefined) throw new Error(`deadline "${patch.deadline}" is not a valid local time.`);
		normalizedDeadlinePatch = formatLocalTime(new Date(deadlineMs));
	}
	next.deadline = patchOptionalString(next.deadline, normalizedDeadlinePatch);
	next.nextAction = patchOptionalString(next.nextAction, patch.nextAction);
	if (patch.waitingFor !== undefined) next.waitingFor = patch.waitingFor;
	if (patch.verificationRequired !== undefined && patch.verificationRequired !== next.verification.required) {
		next.verification = { required: patch.verificationRequired, status: "pending" };
	}
	return next;
}

export function taskPriorityRank(priority: TaskPriority): number {
	return { critical: 0, high: 1, normal: 2, low: 3 }[priority];
}

/**
 * Return a deterministic governance violation for a live task. Sleeping tasks have no current
 * work, so a deadline cannot stop them; waiting and active tasks are both subject to it — a
 * deadline is the user's own intent, not something a task can dodge by parking.
 */
export function taskBudgetViolation(
	control: TaskControl,
	nowMs: number,
	status: "active" | "waiting" | "sleeping" = "active",
): string | undefined {
	if (status === "sleeping") return undefined;
	if (control.deadline) {
		const deadlineMs = parseLocalTime(control.deadline);
		if (deadlineMs !== undefined && deadlineMs < nowMs) return `deadline exceeded (${control.deadline})`;
	}
	return undefined;
}
