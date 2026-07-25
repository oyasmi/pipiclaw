import { errorMessage } from "../shared/text-utils.js";
export type TaskPriority = "low" | "normal" | "high" | "critical";
/**
 * Whether the task may touch systems outside the workspace. Only `external` carries machine
 * semantics (it gates the approval chain); the former `read-only`/`workspace` split had no
 * enforcement anywhere and is read back as `workspace`.
 */
export type TaskSideEffects = "workspace" | "external";
export type TaskVerificationStatus = "pending" | "passed" | "failed";
/**
 * How the last agent run on this task ended. Pure telemetry, written only by the runtime
 * (attempt claim/finish and governor escalation) — never by a `task_manage` action or a
 * `/tasks` command, so it cannot drift into a second state machine alongside `status`.
 */
export type TaskOutcome = "pending" | "running" | "progress" | "blocked" | "failed";
/** Who paused a task: a user via /tasks pause, or the deterministic governor (ex-`escalated`). */
export type TaskPausedBy = "user" | "governor";

/**
 * The single per-task stop-loss (spec 036, D1).
 *
 * Token / cost / wall-time budgets were removed: they are per-task per-cycle, while spend is
 * global — fifty individually-compliant tasks still burn through a monthly budget. Cost control
 * belongs in a global spend guard, not here. `usage` below still *measures* all four dimensions;
 * only the enforcement was dropped.
 */
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

/**
 * Independent acceptance state (spec 036, D5).
 *
 * There used to be two shapes here, `mode: "evidence" | "independent"`. The `evidence` half was
 * the maker writing `status: "passed"` about its own work at `done` time, duplicating the
 * Summary/Evidence already appended to the task body — a record, not a check. Only the
 * independent form ever verified anything, so `mode` collapsed to a single boolean: does closing
 * this task require a separate verifier's attestation?
 *
 * Dropping the second shape also removed five contradictory defaults for it (create said
 * evidence, body rendering and the disk parser said independent).
 */
export interface TaskVerification {
	/** True ⇒ `done` requires a matching attestation on disk from a `purpose=verify` sub-agent. */
	required: boolean;
	status: TaskVerificationStatus;
	runId?: string;
	evidence?: string;
	/**
	 * Hash of the task's *contract* segment, not the whole body (see `taskBodyHash`). The key
	 * keeps its historical name: renaming it would make every stored task's recorded PASS
	 * unreadable and force a re-verify, which is not worth a naming fix.
	 */
	bodyHash?: string;
	checkedAt?: string;
	/** Git view of the artifacts the verifier inspected; guards against edits between verify and done. */
	subjectHash?: string;
}

export interface TaskControl {
	version: 1;
	priority: TaskPriority;
	deadline?: string;
	nextAction?: string;
	lastOutcome: TaskOutcome;
	blockedReason?: string;
	sideEffects: TaskSideEffects;
	externalApproval: "not-required" | "required" | "granted";
	approvalBy?: string;
	approvedAt?: string;
	approvalBodyHash?: string;
	budget: TaskBudget;
	/** Usage in the current recurring cycle (or the full one-shot task). */
	usage: TaskUsage;
	verification: TaskVerification;
	lastStartedAt?: string;
	lastFinishedAt?: string;
	/** Identifier of the currently open recurring-task cycle, when applicable. */
	cycleId?: string;
	/** Present only while status is `paused`; distinguishes a user pause from a governor pause. */
	pausedBy?: TaskPausedBy;
}

export interface TaskControlPatch {
	priority?: TaskPriority;
	deadline?: string;
	nextAction?: string;
	blockedReason?: string;
	sideEffects?: TaskSideEffects;
	externalApproval?: "not-required" | "required" | "granted";
	maxAttempts?: number;
	/** Whether closing this task requires an independent verifier attestation (spec 036, D5). */
	verificationRequired?: boolean;
}

const PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high", "critical"];
const SIDE_EFFECTS: readonly TaskSideEffects[] = ["workspace", "external"];
const VERIFICATION_STATUSES: readonly TaskVerificationStatus[] = ["pending", "passed", "failed"];
const OUTCOMES: readonly TaskOutcome[] = ["pending", "running", "progress", "blocked", "failed"];
const PAUSED_BY: readonly TaskPausedBy[] = ["user", "governor"];

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

/**
 * Read `verification.required`, mapping the retired `mode` enum losslessly (spec 036, D5/D8):
 * `"independent"` was the only form that gated `done`, so it becomes `true`; `"evidence"` was
 * maker self-certification and becomes `false`.
 */
function parseVerificationRequired(verification: Record<string, unknown>): boolean {
	if (typeof verification.required === "boolean") return verification.required;
	return verification.mode === "independent";
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`control enum value must be one of: ${values.join(", ")}`);
	}
	return value as T;
}

/**
 * Values retired from an enum are read back as their canonical replacement rather than failing
 * the parse, so task files written by an older build stay readable; the next write normalizes
 * them on disk and no migration script is needed. Keys retired outright are simply ignored:
 * `control.isolation`, and — per spec 036 — `parent`, `dependsOn`, `worktree`, `lifetimeUsage`
 * and the `budget.max{Tokens,CostUsd,WallTimeMinutes}` trio. They are listed in
 * `RETIRED_TASK_CONTROL_KEYS` so `/tasks doctor` can report what a stored task still carries;
 * dropping `parent`/`dependsOn` silently discards an ordering intent the user once expressed,
 * which is exactly why it must be reported rather than only ignored (D8).
 */
function canonicalEnumValue(value: unknown): unknown {
	switch (value) {
		// The read-only/workspace split never gated anything; only `external` has semantics.
		case "read-only":
			return "workspace";
		// Outcomes once written by `task_manage` actions; the runtime now owns this field and
		// records only how the last run ended.
		case "verified":
		case "skipped":
			return "progress";
		default:
			return value;
	}
}

/**
 * Control keys that older builds wrote and this one ignores (spec 036, D8).
 *
 * Ignoring them keeps stored tasks readable with no migration script, but silence would be
 * wrong for `parent`/`dependsOn`: the task survives, the ordering constraint it expressed does
 * not. `/tasks doctor` reports whatever a stored control block still carries so the loss is
 * visible rather than silent.
 */
export const RETIRED_TASK_CONTROL_KEYS: readonly string[] = [
	"parent",
	"dependsOn",
	"worktree",
	"lifetimeUsage",
	"isolation",
	"budget.maxTokens",
	"budget.maxCostUsd",
	"budget.maxWallTimeMinutes",
];

/** Retired keys actually present in a raw stored control block, in `RETIRED_TASK_CONTROL_KEYS` order. */
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
		version: 1,
		priority: "normal",
		lastOutcome: "pending",
		sideEffects: "workspace",
		externalApproval: "not-required",
		budget: { maxAttempts: 12 },
		usage: { attempts: 0, tokens: 0, costUsd: 0, costKnown: true, wallTimeMinutes: 0 },
		verification: { required: requiresVerification, status: "pending" },
	};
}

export function parseTaskControl(raw: string): TaskControl {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new Error(`control is not valid JSON: ${errorMessage(error)}`);
	}
	if (!isRecord(value) || value.version !== 1) {
		throw new Error("control must be a version 1 JSON object");
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
	if (deadline && !Number.isFinite(new Date(deadline).getTime())) {
		throw new Error("control.deadline must be a valid ISO8601 date");
	}
	const sideEffects = enumValue(canonicalEnumValue(value.sideEffects), SIDE_EFFECTS, "workspace");
	const externalApproval = enumValue(
		value.externalApproval,
		["not-required", "required", "granted"] as const,
		"not-required",
	);
	const approvalBy = optionalString(value.approvalBy);
	const approvedAt = optionalString(value.approvedAt);
	const approvalBodyHash = optionalString(value.approvalBodyHash);
	if (
		externalApproval === "granted" &&
		(sideEffects !== "external" ||
			!approvalBy ||
			!approvedAt ||
			!Number.isFinite(new Date(approvedAt).getTime()) ||
			!approvalBodyHash ||
			!/^[a-f0-9]{64}$/i.test(approvalBodyHash))
	) {
		throw new Error(
			"granted external approval requires external side effects, approvalBy, approvedAt, and approvalBodyHash",
		);
	}

	return {
		version: 1,
		priority: enumValue(value.priority, PRIORITIES, "normal"),
		deadline,
		nextAction: optionalString(value.nextAction),
		lastOutcome: enumValue(canonicalEnumValue(value.lastOutcome), OUTCOMES, "pending"),
		blockedReason: optionalString(value.blockedReason),
		sideEffects,
		externalApproval,
		approvalBy,
		approvedAt,
		approvalBodyHash,
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
		lastStartedAt: optionalString(value.lastStartedAt),
		lastFinishedAt: optionalString(value.lastFinishedAt),
		cycleId: optionalString(value.cycleId),
		pausedBy: value.pausedBy === undefined ? undefined : enumValue(value.pausedBy, PAUSED_BY, "user"),
	};
}

/** Reset state which is meaningful only within one recurring task cycle. */
export function resetTaskControlForCycle(control: TaskControl, cycleId: string): TaskControl {
	const normalizedCycleId = cycleId.trim();
	if (!normalizedCycleId) throw new Error("cycleId must not be empty.");
	return {
		...structuredClone(control),
		nextAction: undefined,
		lastOutcome: "pending",
		blockedReason: undefined,
		// A cycle invalidates a one-time grant, but preserves an explicit policy
		// exemption for recurring automation.
		externalApproval:
			control.sideEffects === "external" && control.externalApproval !== "not-required"
				? "required"
				: "not-required",
		approvalBy: undefined,
		approvedAt: undefined,
		approvalBodyHash: undefined,
		usage: { attempts: 0, tokens: 0, costUsd: 0, costKnown: true, wallTimeMinutes: 0 },
		verification: { required: control.verification.required, status: "pending" },
		lastStartedAt: undefined,
		lastFinishedAt: undefined,
		cycleId: normalizedCycleId,
		pausedBy: undefined,
	};
}

function patchOptionalString(current: string | undefined, value: string | undefined): string | undefined {
	if (value === undefined) return current;
	return value.trim() || undefined;
}

export function applyTaskControlPatch(control: TaskControl, patch: TaskControlPatch): TaskControl {
	const next: TaskControl = structuredClone(control);
	const invalidatesApproval = control.externalApproval === "granted" && Object.keys(patch).length > 0;
	const explicitlySetsExternalApproval = patch.externalApproval !== undefined;
	if (patch.priority !== undefined) next.priority = patch.priority;
	if (patch.deadline?.trim() && !Number.isFinite(new Date(patch.deadline).getTime())) {
		throw new Error(`deadline "${patch.deadline}" is not a valid ISO8601 date.`);
	}
	next.deadline = patchOptionalString(next.deadline, patch.deadline);
	next.nextAction = patchOptionalString(next.nextAction, patch.nextAction);
	next.blockedReason = patchOptionalString(next.blockedReason, patch.blockedReason);
	if (patch.sideEffects !== undefined) next.sideEffects = patch.sideEffects;
	if (patch.externalApproval !== undefined) next.externalApproval = patch.externalApproval;
	if (patch.maxAttempts !== undefined) {
		if (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1) {
			throw new Error("maxAttempts must be a positive integer.");
		}
		next.budget.maxAttempts = patch.maxAttempts;
	}
	if (patch.verificationRequired !== undefined && patch.verificationRequired !== next.verification.required) {
		next.verification = { required: patch.verificationRequired, status: "pending" };
	}
	if (next.sideEffects !== "external") {
		next.externalApproval = "not-required";
		next.approvalBy = undefined;
		next.approvedAt = undefined;
		next.approvalBodyHash = undefined;
	}
	if (control.sideEffects !== "external" && next.sideEffects === "external" && !explicitlySetsExternalApproval) {
		next.externalApproval = "required";
	}
	// Spec 036 D5: a task that changes an outside system is exactly the one nobody is watching
	// under unattended operation, so it defaults to requiring independent acceptance. An explicit
	// `verificationRequired: false` still wins.
	if (
		control.sideEffects !== "external" &&
		next.sideEffects === "external" &&
		patch.verificationRequired === undefined &&
		!next.verification.required
	) {
		next.verification = { required: true, status: "pending" };
	}
	if (invalidatesApproval && next.sideEffects === "external" && !explicitlySetsExternalApproval) {
		next.externalApproval = "required";
	}
	if (next.externalApproval !== "granted") {
		next.approvalBy = undefined;
		next.approvedAt = undefined;
		next.approvalBodyHash = undefined;
	}
	return next;
}

export function taskPriorityRank(priority: TaskPriority): number {
	return { critical: 0, high: 1, normal: 2, low: 3 }[priority];
}

export function taskBudgetViolation(control: TaskControl, nowMs: number): string | undefined {
	if (control.deadline) {
		const deadlineMs = new Date(control.deadline).getTime();
		if (Number.isFinite(deadlineMs) && deadlineMs < nowMs) return `deadline exceeded (${control.deadline})`;
	}
	if (control.usage.attempts >= control.budget.maxAttempts) {
		return `attempt budget exhausted (${control.usage.attempts}/${control.budget.maxAttempts})`;
	}
	return undefined;
}

export function invalidateTaskVerification(control: TaskControl): TaskControl {
	if (control.verification.status === "pending") return control;
	return { ...control, verification: { required: control.verification.required, status: "pending" } };
}

export function invalidateTaskApproval(control: TaskControl): TaskControl {
	if (control.sideEffects !== "external" || control.externalApproval !== "granted") return control;
	return {
		...control,
		externalApproval: "required",
		approvalBy: undefined,
		approvedAt: undefined,
		approvalBodyHash: undefined,
	};
}
