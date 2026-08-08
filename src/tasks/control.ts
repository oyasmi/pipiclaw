import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";

export type TaskPriority = "low" | "normal" | "high" | "critical";
export type TaskVerificationStatus = "pending" | "passed" | "failed";
export type TaskWaitingFor = "time" | "user" | "job" | "verification" | "external-signal";

/** How the last agent run ended. This is telemetry, not a lifecycle state. */
export type TaskOutcome = "pending" | "running" | "progress" | "blocked" | "failed";

export interface TaskBudget {
	maxAttempts: number;
}

export interface TaskUsage {
	attempts: number;
	tokens: number;
	costUsd: number;
	/** False when at least one contributing model omitted pricing metadata. */
	costKnown: boolean;
	wallTimeMinutes: number;
}

export interface TaskVerification {
	required: boolean;
	status: TaskVerificationStatus;
	runId?: string;
	evidence?: string;
	/** Hash of the task contract segment inspected by the verifier. */
	bodyHash?: string;
	checkedAt?: string;
	/** Git view of the artifacts the verifier inspected. */
	subjectHash?: string;
}

export interface TaskStop {
	by: "user" | "governor";
	reason: string;
	at: string;
}

export interface TaskProvenance {
	createdBy?: string;
	createdAt?: string;
	sourceMessageId?: string;
}

/** Durable ownership marker for the interval between a structured completion wake activating a
 * task and its transport accepting the corresponding turn. */
export interface TaskWakeHandoff {
	kind: "subagent";
	resourceId: string;
	dispatchId: string;
	generation: number;
	previousLastOutcome: TaskOutcome;
	previousBlockedReason?: string;
	previousLastStartedAt?: string;
}

/** The v2 persisted control block. Execution authority comes from capability and scope. */
export interface TaskControl {
	version: 2;
	priority: TaskPriority;
	deadline?: string;
	nextAction?: string;
	blockedReason?: string;
	waitingFor?: TaskWaitingFor;
	budget: TaskBudget;
	usage: TaskUsage;
	verification: TaskVerification;
	attemptGeneration: number;
	lastOutcome: TaskOutcome;
	lastStartedAt?: string;
	lastFinishedAt?: string;
	/** Current or most recently closed recurring occurrence. */
	cycleId?: string;
	/** Present only while the task is disabled. */
	stop?: TaskStop;
	provenance?: TaskProvenance;
	wakeHandoff?: TaskWakeHandoff;
}

export interface TaskControlPatch {
	priority?: TaskPriority;
	deadline?: string;
	nextAction?: string;
	blockedReason?: string;
	waitingFor?: TaskWaitingFor;
	maxAttempts?: number;
	verificationRequired?: boolean;
}

export const TASK_PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high", "critical"];
const WAITING_FOR: readonly TaskWaitingFor[] = ["time", "user", "job", "verification", "external-signal"];
const VERIFICATION_STATUSES: readonly TaskVerificationStatus[] = ["pending", "passed", "failed"];
const OUTCOMES: readonly TaskOutcome[] = ["pending", "running", "progress", "blocked", "failed"];

function normalizeLegacyOutcome(value: unknown): unknown {
	return value === "verified" || value === "skipped" ? "progress" : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error("control usage values must be finite non-negative numbers");
	}
	return value;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error("control.attemptGeneration must be a non-negative integer; remove it to rebuild from 0.");
	}
	return value;
}

function parseTaskUsage(value: Record<string, unknown>): TaskUsage {
	const attempts = Math.floor(finiteNonNegative(value.attempts));
	const tokens = Math.floor(finiteNonNegative(value.tokens));
	const costUsd = finiteNonNegative(value.costUsd);
	const wallTimeMinutes = finiteNonNegative(value.wallTimeMinutes);
	const costKnown =
		typeof value.costKnown === "boolean" ? value.costKnown : costUsd > 0 || (tokens === 0 && wallTimeMinutes === 0);
	return { attempts, tokens, costUsd, costKnown, wallTimeMinutes };
}

function optionalPositive(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error("control budget values must be finite positive numbers");
	}
	return value;
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

function parseProvenance(value: unknown): TaskProvenance | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("control.provenance must be an object");
	const createdBy = optionalString(value.createdBy);
	const createdAt = optionalString(value.createdAt);
	const sourceMessageId = optionalString(value.sourceMessageId);
	if (createdAt && parseLocalTime(createdAt) === undefined) {
		throw new Error("control.provenance.createdAt must be a valid local time");
	}
	return { createdBy, createdAt, sourceMessageId };
}

function parseWakeHandoff(value: unknown): TaskWakeHandoff | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new Error("control.wakeHandoff must be an object");
	if (value.kind !== "subagent" || typeof value.resourceId !== "string" || typeof value.dispatchId !== "string") {
		throw new Error("control.wakeHandoff requires kind=subagent, resourceId, and dispatchId");
	}
	return {
		kind: "subagent",
		resourceId: value.resourceId,
		dispatchId: value.dispatchId,
		generation: nonNegativeInteger(value.generation),
		previousLastOutcome: enumValue(normalizeLegacyOutcome(value.previousLastOutcome), OUTCOMES, "pending"),
		previousBlockedReason: optionalString(value.previousBlockedReason),
		previousLastStartedAt: optionalString(value.previousLastStartedAt),
	};
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

export function createDefaultTaskControl(requiresVerification = false, provenance?: TaskProvenance): TaskControl {
	return {
		version: 2,
		priority: "normal",
		budget: { maxAttempts: 12 },
		usage: {
			attempts: 0,
			tokens: 0,
			costUsd: 0,
			costKnown: true,
			wallTimeMinutes: 0,
		},
		verification: { required: requiresVerification, status: "pending" },
		attemptGeneration: 0,
		lastOutcome: "pending",
		...(provenance ? { provenance } : {}),
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

	const budget = isRecord(value.budget) ? value.budget : {};
	const usage = isRecord(value.usage) ? value.usage : {};
	const parsedUsage = parseTaskUsage(usage);
	const verification = isRecord(value.verification) ? value.verification : {};
	const maxAttempts = optionalPositive(budget.maxAttempts);
	if (!maxAttempts || !Number.isInteger(maxAttempts)) {
		throw new Error("control.budget.maxAttempts must be a positive integer");
	}
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
		blockedReason: optionalString(value.blockedReason),
		waitingFor,
		budget: { maxAttempts: Math.max(1, Math.floor(maxAttempts)) },
		usage: parsedUsage,
		verification: {
			required: parseVerificationRequired(verification),
			status: enumValue(verification.status, VERIFICATION_STATUSES, "pending"),
			runId: optionalString(verification.runId),
			evidence: optionalString(verification.evidence),
			bodyHash: optionalString(verification.bodyHash),
			checkedAt: optionalString(verification.checkedAt),
			subjectHash: optionalString(verification.subjectHash),
		},
		attemptGeneration: nonNegativeInteger(value.attemptGeneration),
		lastOutcome: enumValue(normalizeLegacyOutcome(value.lastOutcome), OUTCOMES, "pending"),
		lastStartedAt: optionalString(value.lastStartedAt),
		lastFinishedAt: optionalString(value.lastFinishedAt),
		cycleId: optionalString(value.cycleId),
		stop,
		provenance: parseProvenance(value.provenance),
		wakeHandoff: parseWakeHandoff(value.wakeHandoff),
	};
}

function zeroUsage(): TaskUsage {
	return { attempts: 0, tokens: 0, costUsd: 0, costKnown: true, wallTimeMinutes: 0 };
}

/** Reset state that is meaningful only within one recurring task cycle. */
export function resetTaskControlForCycle(control: TaskControl, cycleId: string): TaskControl {
	const normalizedCycleId = cycleId.trim();
	if (!normalizedCycleId) throw new Error("cycleId must not be empty.");
	return {
		...structuredClone(control),
		nextAction: undefined,
		lastOutcome: "pending",
		blockedReason: undefined,
		waitingFor: undefined,
		usage: zeroUsage(),
		verification: { required: control.verification.required, status: "pending" },
		lastStartedAt: undefined,
		lastFinishedAt: undefined,
		cycleId: normalizedCycleId,
		stop: undefined,
		wakeHandoff: undefined,
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
	next.blockedReason = patchOptionalString(next.blockedReason, patch.blockedReason);
	if (patch.waitingFor !== undefined) next.waitingFor = patch.waitingFor;
	if (patch.maxAttempts !== undefined) {
		if (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1) {
			throw new Error("maxAttempts must be a positive integer.");
		}
		next.budget.maxAttempts = patch.maxAttempts;
	}
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
 * work, so neither a deadline nor an attempt budget may stop them. Waiting tasks are subject to
 * their deadline but do not spend attempt budget while parked.
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
	if (status === "active" && control.usage.attempts >= control.budget.maxAttempts) {
		return `attempt budget exhausted (${control.usage.attempts}/${control.budget.maxAttempts})`;
	}
	return undefined;
}
