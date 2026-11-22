import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { allCases } from "../cases/index.js";
import { caseHash } from "./cases.js";
import { executionFingerprint } from "./execution-state.js";
import { canonicalJson } from "./fingerprint.js";
import { trialSeed } from "./fixture-seed.js";
import { oracleFingerprint } from "./oracle-checks.js";
import type { EvalCase, ExecutionSlot, FrozenExecutionPlan } from "./schema.js";
import { option, profiles, selectCases } from "./selection.js";
import { hash } from "./util.js";

function positive(args: string[], flag: string, fallback?: number): number | undefined {
	const raw = option(args, flag);
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive finite number.`);
	return value;
}

export function planEnvelope(cases: EvalCase[], trials: number) {
	return {
		agentCeilingUsd: cases.reduce((sum, item) => sum + (item.budget?.maxCostUsd ?? 0.5) * trials, 0),
		// Reserve watchdog grace and grading for each trial.
		wallCeilingMs: cases.reduce((sum, item) => sum + ((item.budget?.maxWallMs ?? 180_000) + 15_000) * trials, 0),
	};
}

export function assertPlanEnvelope(cases: EvalCase[], trials: number, budgets: FrozenExecutionPlan["budgets"]) {
	const { agentCeilingUsd, wallCeilingMs } = planEnvelope(cases, trials);
	const { maxCostUsd, maxWallMinutes } = budgets;
	const maxWallMs = maxWallMinutes * 60_000;
	if (agentCeilingUsd > maxCostUsd || wallCeilingMs > maxWallMs)
		throw new Error(
			`Eval plan exceeds its envelope ($${agentCeilingUsd.toFixed(2)} / ${(wallCeilingMs / 60_000).toFixed(1)} serial minutes). Reduce cases/trials or set explicit --max-cost-usd and --max-wall-minutes. Model requests: 0.`,
		);
	return { maxCostUsd, maxWallMs, agentCeilingUsd, wallCeilingMs };
}

export function executionCases(plan: FrozenExecutionPlan): EvalCase[] {
	const ids = new Set(plan.slots.map((slot) => slot.caseId));
	return allCases.filter((item) => ids.has(item.id));
}

function planIdentity(cases: EvalCase[], root: string): FrozenExecutionPlan["identity"] {
	return {
		cases: hash(cases.map((item) => `${item.id}:${caseHash(item, root)}`).join("\n")),
		oracles: hash(cases.map((item) => `${item.id}:${oracleFingerprint(item, root)}`).join("\n")),
		execution: executionFingerprint(root),
	};
}

function executionSlots(cases: EvalCase[], trials: number): ExecutionSlot[] {
	return cases.flatMap((item) =>
		Array.from({ length: trials }, (_, index) => ({
			caseId: item.id,
			trial: index + 1,
			seed: trialSeed(item.id, index + 1),
		})),
	);
}

export function buildExecutionPlan(args: string[], root = process.cwd()): FrozenExecutionPlan {
	const { cases, ...selection } = selectCases(args, false, root);
	const budgets: FrozenExecutionPlan["budgets"] = {
		maxCostUsd: positive(args, "--max-cost-usd", 25)!,
		maxWallMinutes: positive(args, "--max-wall-minutes", 180)!,
		maxTokens: positive(args, "--max-tokens"),
		maxElapsedMinutes: positive(args, "--max-elapsed-minutes"),
		unknownUsage: "stop",
	};
	assertPlanEnvelope(cases, selection.trials, budgets);
	return {
		schemaVersion: 2,
		...selection,
		slots: executionSlots(cases, selection.trials),
		budgets,
		identity: planIdentity(cases, root),
	};
}

export function loadExecutionPlan(path: string): FrozenExecutionPlan {
	const plan = JSON.parse(readFileSync(path, "utf8")) as FrozenExecutionPlan;
	if (plan?.schemaVersion !== 2)
		throw new Error(`Unsupported execution plan ${path}. Rebuild it with eval plan --output. Model requests: 0.`);
	return plan;
}

/** Refuse to start model calls when the frozen plan no longer matches the checkout. */
export function assertPlanIdentity(plan: FrozenExecutionPlan, root = process.cwd()): void {
	const fail = (reason: string): never => {
		throw new Error(`Execution plan ${reason}. Rebuild it with eval plan --output. Model requests: 0.`);
	};
	const budget = plan.budgets;
	const positive = (value: unknown): value is number =>
		typeof value === "number" && Number.isFinite(value) && value > 0;
	if (
		!Object.hasOwn(profiles, plan.profile) ||
		![plan.trials, plan.concurrency, plan.judgeConcurrency].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
		typeof plan.judgeEnabled !== "boolean" ||
		!budget ||
		!positive(budget.maxCostUsd) ||
		!positive(budget.maxWallMinutes) ||
		(budget.maxTokens !== undefined && !positive(budget.maxTokens)) ||
		(budget.maxElapsedMinutes !== undefined && !positive(budget.maxElapsedMinutes)) ||
		budget.unknownUsage !== "stop" ||
		!Array.isArray(plan.slots) ||
		plan.slots.some((slot) => !slot || typeof slot.caseId !== "string")
	)
		fail("contains invalid scheduling or budget fields");
	const cases = executionCases(plan);
	if (
		plan.slots.length !== cases.length * plan.trials ||
		canonicalJson(plan.slots) !== canonicalJson(executionSlots(cases, plan.trials))
	)
		fail("has a different slot list, order, or fixture seed");
	const identity = planIdentity(cases, root);
	if (canonicalJson(identity) !== canonicalJson(plan.identity))
		fail("identity is stale (case, oracle, fixture, compiled runtime, or gate changed)");
	assertPlanEnvelope(cases, plan.trials, plan.budgets);
}

export function planPath(path: string, root = process.cwd()): string {
	return resolve(root, path);
}
