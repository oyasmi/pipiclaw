import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allCases } from "../cases/index.js";
import { caseHash } from "./cases.js";
import { trialSeed } from "./fixture-seed.js";
import { oracleFingerprint } from "./oracle-checks.js";
import type { CaseSelection } from "./selection.js";
import { option, selectCases } from "./selection.js";
import { hash } from "./util.js";

export interface ExecutionSlot {
	caseId: string;
	trial: number;
	seed: string;
}

export interface FrozenExecutionPlan {
	schemaVersion: 1;
	profile: string;
	trials: number;
	concurrency: number;
	judgeConcurrency: number;
	reasons: Record<string, string[]>;
	uncovered: string[];
	unknownPaths: string[];
	emptyReason?: string;
	slots: ExecutionSlot[];
	budgets: {
		maxCostUsd: number;
		maxWallMinutes: number;
		maxTokens?: number;
		maxElapsedMinutes?: number;
		unknownUsage: "stop";
	};
	identity: { cases: string; oracles: string };
}

function positive(args: string[], flag: string): number | undefined {
	const raw = option(args, flag);
	if (raw === undefined) return;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive finite number.`);
	return value;
}

export function planIdentity(caseIds: string[], root = process.cwd()): { cases: string; oracles: string } {
	const cases = caseIds.map((id) => {
		const item = allCases.find((candidate) => candidate.id === id);
		if (!item) throw new Error(`Plan case ${id} is not in the current catalog. Rebuild the plan. Model requests: 0.`);
		return `${id}:${caseHash(item, root)}`;
	});
	const oracles = caseIds.map((id) => {
		const item = allCases.find((candidate) => candidate.id === id);
		if (!item) throw new Error(`Plan case ${id} is not in the current catalog. Rebuild the plan. Model requests: 0.`);
		return `${id}:${oracleFingerprint(item, root)}`;
	});
	return { cases: hash(cases.join("\n")), oracles: hash(oracles.join("\n")) };
}

export function buildExecutionPlan(args: string[], root = process.cwd()): FrozenExecutionPlan {
	const selection: CaseSelection = selectCases(args, false, root);
	const slots: ExecutionSlot[] = [];
	for (const item of selection.cases)
		for (let trial = 1; trial <= selection.trials; trial++)
			slots.push({ caseId: item.id, trial, seed: trialSeed(item.id, trial) });
	const maxCostUsd =
		positive(args, "--max-cost-usd") ??
		selection.cases.reduce((sum, item) => sum + (item.budget?.maxCostUsd ?? 0.5) * selection.trials, 0);
	const maxWallMinutes =
		positive(args, "--max-wall-minutes") ??
		selection.cases.reduce((sum, item) => sum + ((item.budget?.maxWallMs ?? 180_000) * selection.trials) / 60_000, 0);
	return {
		schemaVersion: 1,
		profile: selection.profile,
		trials: selection.trials,
		concurrency: selection.concurrency,
		judgeConcurrency: selection.judgeConcurrency,
		reasons: selection.reasons,
		uncovered: selection.uncovered,
		unknownPaths: selection.unknownPaths,
		emptyReason: selection.emptyReason,
		slots,
		budgets: {
			maxCostUsd,
			maxWallMinutes,
			maxTokens: positive(args, "--max-tokens"),
			maxElapsedMinutes: positive(args, "--max-elapsed-minutes"),
			unknownUsage: "stop",
		},
		identity: planIdentity(
			selection.cases.map((item) => item.id),
			root,
		),
	};
}

export function loadExecutionPlan(path: string): FrozenExecutionPlan {
	const plan = JSON.parse(readFileSync(path, "utf8")) as FrozenExecutionPlan;
	if (plan.schemaVersion !== 1 || !Array.isArray(plan.slots))
		throw new Error(`Unsupported execution plan ${path}. Rebuild it with eval plan --output. Model requests: 0.`);
	return plan;
}

/** Refuse to start model calls when the frozen plan no longer matches the checkout. */
export function assertPlanIdentity(plan: FrozenExecutionPlan, root = process.cwd()): void {
	const ids = [...new Set(plan.slots.map((slot) => slot.caseId))];
	const identity = planIdentity(ids, root);
	if (identity.cases !== plan.identity.cases || identity.oracles !== plan.identity.oracles)
		throw new Error(
			"Execution plan identity is stale (case, oracle, or fixture changed). Rebuild it with eval plan --output before running. Model requests: 0.",
		);
	for (const slot of plan.slots)
		if (trialSeed(slot.caseId, slot.trial) !== slot.seed)
			throw new Error(
				`Execution plan seed for ${slot.caseId}#${slot.trial} does not match the current fixture seed. Rebuild the plan. Model requests: 0.`,
			);
}

export function planPath(path: string, root = process.cwd()): string {
	return path.startsWith("/") ? path : join(root, path);
}

export function applyRunBudget(env: NodeJS.ProcessEnv, budgets: FrozenExecutionPlan["budgets"]): void {
	delete env.EVAL_MAX_TOKENS;
	delete env.EVAL_MAX_ELAPSED_MINUTES;
	if (budgets.maxTokens !== undefined) env.EVAL_MAX_TOKENS = String(budgets.maxTokens);
	if (budgets.maxElapsedMinutes !== undefined) env.EVAL_MAX_ELAPSED_MINUTES = String(budgets.maxElapsedMinutes);
}
