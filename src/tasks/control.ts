import { errorMessage } from "../shared/text-utils.js";
export type TaskPriority = "low" | "normal" | "high" | "critical";
export type TaskIsolation = "shared" | "worktree";
export type TaskSideEffects = "read-only" | "workspace" | "external";
export type TaskVerificationMode = "evidence" | "independent";
export type TaskVerificationStatus = "pending" | "passed" | "failed";
export type TaskOutcome = "pending" | "running" | "progress" | "blocked" | "failed" | "verified";

export interface TaskBudget {
	maxAttempts: number;
	maxTokens?: number;
	maxCostUsd?: number;
	maxWallTimeMinutes?: number;
}

export interface TaskUsage {
	attempts: number;
	tokens: number;
	costUsd: number;
	wallTimeMinutes: number;
}

export interface TaskVerification {
	mode: TaskVerificationMode;
	status: TaskVerificationStatus;
	runId?: string;
	evidence?: string;
	bodyHash?: string;
	checkedAt?: string;
	subjectHash?: string;
}

export interface TaskWorktree {
	path: string;
	branch?: string;
}

export interface TaskControl {
	version: 1;
	priority: TaskPriority;
	deadline?: string;
	nextAction?: string;
	lastOutcome: TaskOutcome;
	blockedReason?: string;
	parent?: string;
	dependsOn: string[];
	isolation: TaskIsolation;
	sideEffects: TaskSideEffects;
	externalApproval: "not-required" | "required" | "granted";
	approvalBy?: string;
	approvedAt?: string;
	approvalBodyHash?: string;
	budget: TaskBudget;
	usage: TaskUsage;
	verification: TaskVerification;
	worktree?: TaskWorktree;
	lastStartedAt?: string;
	lastFinishedAt?: string;
	/** Identifier of the currently open recurring-task cycle, when applicable. */
	cycleId?: string;
}

export interface TaskControlPatch {
	priority?: TaskPriority;
	deadline?: string;
	nextAction?: string;
	lastOutcome?: TaskOutcome;
	blockedReason?: string;
	parent?: string;
	dependsOn?: string[];
	isolation?: TaskIsolation;
	sideEffects?: TaskSideEffects;
	externalApproval?: "not-required" | "required" | "granted";
	maxAttempts?: number;
	maxTokens?: number;
	maxCostUsd?: number;
	maxWallTimeMinutes?: number;
	verificationMode?: TaskVerificationMode;
	worktreePath?: string;
	worktreeBranch?: string;
}

const PRIORITIES: readonly TaskPriority[] = ["low", "normal", "high", "critical"];
const ISOLATIONS: readonly TaskIsolation[] = ["shared", "worktree"];
const SIDE_EFFECTS: readonly TaskSideEffects[] = ["read-only", "workspace", "external"];
const VERIFICATION_MODES: readonly TaskVerificationMode[] = ["evidence", "independent"];
const VERIFICATION_STATUSES: readonly TaskVerificationStatus[] = ["pending", "passed", "failed"];
const OUTCOMES: readonly TaskOutcome[] = ["pending", "running", "progress", "blocked", "failed", "verified"];
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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

function taskIds(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("control.dependsOn must be an array of task ids");
	if (value.some((item) => typeof item !== "string" || !TASK_ID_PATTERN.test(item.trim()))) {
		throw new Error("control.dependsOn contains an invalid task id");
	}
	return Array.from(
		new Set(
			value
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter((item) => TASK_ID_PATTERN.test(item)),
		),
	);
}

function validateTaskId(value: string | undefined, field: string): void {
	if (value && !TASK_ID_PATTERN.test(value)) throw new Error(`${field} contains an invalid task id: ${value}`);
}

export function createDefaultTaskControl(mode: TaskVerificationMode = "independent"): TaskControl {
	return {
		version: 1,
		priority: "normal",
		lastOutcome: "pending",
		dependsOn: [],
		isolation: "shared",
		sideEffects: "workspace",
		externalApproval: "not-required",
		budget: { maxAttempts: 12 },
		usage: { attempts: 0, tokens: 0, costUsd: 0, wallTimeMinutes: 0 },
		verification: { mode, status: "pending" },
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
	const verification = isRecord(value.verification) ? value.verification : {};
	const worktree = isRecord(value.worktree) ? value.worktree : undefined;
	const maxAttempts = optionalPositive(budget.maxAttempts);
	if (!maxAttempts || !Number.isInteger(maxAttempts)) {
		throw new Error("control.budget.maxAttempts must be a positive integer");
	}
	const deadline = optionalString(value.deadline);
	if (deadline && !Number.isFinite(new Date(deadline).getTime())) {
		throw new Error("control.deadline must be a valid ISO8601 date");
	}
	const parent = optionalString(value.parent);
	validateTaskId(parent, "control.parent");
	const sideEffects = enumValue(value.sideEffects, SIDE_EFFECTS, "workspace");
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
	if (value.worktree !== undefined && (!worktree || !optionalString(worktree.path))) {
		throw new Error("control.worktree must contain a non-empty path");
	}

	return {
		version: 1,
		priority: enumValue(value.priority, PRIORITIES, "normal"),
		deadline,
		nextAction: optionalString(value.nextAction),
		lastOutcome: enumValue(value.lastOutcome, OUTCOMES, "pending"),
		blockedReason: optionalString(value.blockedReason),
		parent,
		dependsOn: taskIds(value.dependsOn),
		isolation: enumValue(value.isolation, ISOLATIONS, "shared"),
		sideEffects,
		externalApproval,
		approvalBy,
		approvedAt,
		approvalBodyHash,
		budget: {
			maxAttempts: Math.max(1, Math.floor(maxAttempts)),
			maxTokens: optionalPositive(budget.maxTokens),
			maxCostUsd: optionalPositive(budget.maxCostUsd),
			maxWallTimeMinutes: optionalPositive(budget.maxWallTimeMinutes),
		},
		usage: {
			attempts: Math.floor(finiteNonNegative(usage.attempts)),
			tokens: Math.floor(finiteNonNegative(usage.tokens)),
			costUsd: finiteNonNegative(usage.costUsd),
			wallTimeMinutes: finiteNonNegative(usage.wallTimeMinutes),
		},
		verification: {
			mode: enumValue(verification.mode, VERIFICATION_MODES, "independent"),
			status: enumValue(verification.status, VERIFICATION_STATUSES, "pending"),
			runId: optionalString(verification.runId),
			evidence: optionalString(verification.evidence),
			bodyHash: optionalString(verification.bodyHash),
			checkedAt: optionalString(verification.checkedAt),
			subjectHash: optionalString(verification.subjectHash),
		},
		worktree: optionalString(worktree?.path)
			? { path: optionalString(worktree?.path)!, branch: optionalString(worktree?.branch) }
			: undefined,
		lastStartedAt: optionalString(value.lastStartedAt),
		lastFinishedAt: optionalString(value.lastFinishedAt),
		cycleId: optionalString(value.cycleId),
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
		usage: { attempts: 0, tokens: 0, costUsd: 0, wallTimeMinutes: 0 },
		verification: { mode: control.verification.mode, status: "pending" },
		worktree: undefined,
		lastStartedAt: undefined,
		lastFinishedAt: undefined,
		cycleId: normalizedCycleId,
	};
}

function patchOptionalString(current: string | undefined, value: string | undefined): string | undefined {
	if (value === undefined) return current;
	return value.trim() || undefined;
}

function patchPositive(current: number | undefined, value: number | undefined, field: string): number | undefined {
	if (value === undefined) return current;
	if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative number.`);
	return value === 0 ? undefined : value;
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
	if (patch.lastOutcome !== undefined) next.lastOutcome = patch.lastOutcome;
	next.blockedReason = patchOptionalString(next.blockedReason, patch.blockedReason);
	next.parent = patchOptionalString(next.parent, patch.parent);
	validateTaskId(next.parent, "parent");
	if (patch.dependsOn !== undefined) {
		for (const dependency of patch.dependsOn) validateTaskId(dependency.trim(), "dependsOn");
		next.dependsOn = taskIds(patch.dependsOn);
	}
	if (patch.isolation !== undefined) next.isolation = patch.isolation;
	if (patch.sideEffects !== undefined) next.sideEffects = patch.sideEffects;
	if (patch.externalApproval !== undefined) next.externalApproval = patch.externalApproval;
	if (patch.maxAttempts !== undefined) {
		if (!Number.isInteger(patch.maxAttempts) || patch.maxAttempts < 1) {
			throw new Error("maxAttempts must be a positive integer.");
		}
		next.budget.maxAttempts = patch.maxAttempts;
	}
	next.budget.maxTokens = patchPositive(next.budget.maxTokens, patch.maxTokens, "maxTokens");
	next.budget.maxCostUsd = patchPositive(next.budget.maxCostUsd, patch.maxCostUsd, "maxCostUsd");
	next.budget.maxWallTimeMinutes = patchPositive(
		next.budget.maxWallTimeMinutes,
		patch.maxWallTimeMinutes,
		"maxWallTimeMinutes",
	);
	if (patch.verificationMode !== undefined && patch.verificationMode !== next.verification.mode) {
		next.verification = { mode: patch.verificationMode, status: "pending" };
	}
	if (patch.worktreePath !== undefined || patch.worktreeBranch !== undefined) {
		const path = patchOptionalString(next.worktree?.path, patch.worktreePath);
		const branch = patchOptionalString(next.worktree?.branch, patch.worktreeBranch);
		next.worktree = path ? { path, branch } : undefined;
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
	if (control.budget.maxTokens !== undefined && control.usage.tokens >= control.budget.maxTokens) {
		return `token budget exhausted (${control.usage.tokens}/${control.budget.maxTokens})`;
	}
	if (control.budget.maxCostUsd !== undefined && control.usage.costUsd >= control.budget.maxCostUsd) {
		return `cost budget exhausted ($${control.usage.costUsd.toFixed(4)}/$${control.budget.maxCostUsd.toFixed(4)})`;
	}
	if (
		control.budget.maxWallTimeMinutes !== undefined &&
		control.usage.wallTimeMinutes >= control.budget.maxWallTimeMinutes
	) {
		return `wall-time budget exhausted (${control.usage.wallTimeMinutes.toFixed(1)}/${control.budget.maxWallTimeMinutes}m)`;
	}
	return undefined;
}

export function invalidateTaskVerification(control: TaskControl): TaskControl {
	if (control.verification.status === "pending") return control;
	return { ...control, verification: { mode: control.verification.mode, status: "pending" } };
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
