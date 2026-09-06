import { parseLocalTime } from "../shared/local-time.js";
import type { TaskBudget, TaskCycle, TaskFrontmatterV4 } from "./frontmatter.js";

/**
 * The cycle budget (spec 051, D6) — what replaced the governor.
 *
 * v3 tried to *infer* whether a task deserved to keep running, from a ten-field ledger
 * fingerprint plus a process-local tally of "effectful" tool calls whose own source comment
 * admitted `echo x` qualified. It fired twice in four months. A budget is the honest version of
 * the same intent: four numbers the task carries, the loop spends, and the user can see and top
 * up. When one runs out the task stops and says so — no guessing about whether the work was real.
 */
export const DEFAULT_TASK_BUDGET: TaskBudget = {
	steps: 40,
	wallMin: 180,
	usd: 8,
	rounds: 4,
};

/** Two consecutive steps that called no tool at all: the loop is talking to itself. */
export const IDLE_STEP_LIMIT = 2;

export function effectiveBudget(fields: TaskFrontmatterV4): TaskBudget {
	return { ...DEFAULT_TASK_BUDGET, ...fields.budget };
}

export type BudgetBreach = "steps" | "wallMin" | "usd" | "rounds" | "until";

export interface BudgetStatus {
	breach?: BudgetBreach;
	reason?: string;
}

/**
 * Whether this cycle has run out of any of its four dimensions. Checked before a step is queued,
 * so a task that is already over budget never spends one more model call to find out.
 */
export function checkBudget(fields: TaskFrontmatterV4, now: Date = new Date()): BudgetStatus {
	const cycle = fields.cycle;
	if (!cycle) return {};
	const budget = effectiveBudget(fields);

	if (cycle.steps >= budget.steps) {
		return { breach: "steps", reason: `本周期已用满 ${budget.steps} 步` };
	}
	if (cycle.rounds >= budget.rounds) {
		return { breach: "rounds", reason: `本周期已返工 ${cycle.rounds} 轮（上限 ${budget.rounds}）` };
	}
	if (cycle.usd >= budget.usd) {
		const estimated = cycle.usdEstimated ? "（含估算）" : "";
		return { breach: "usd", reason: `本周期成本已达 $${cycle.usd.toFixed(2)}${estimated}（上限 $${budget.usd}）` };
	}
	const startedMs = parseLocalTime(cycle.startedAt);
	if (startedMs !== undefined && now.getTime() - startedMs >= budget.wallMin * 60_000) {
		return { breach: "wallMin", reason: `本周期已运行超过 ${budget.wallMin} 分钟` };
	}
	const untilMs = budget.until ? parseLocalTime(budget.until) : undefined;
	if (untilMs !== undefined && untilMs <= now.getTime()) {
		return { breach: "until", reason: `已超过期限 ${budget.until}` };
	}
	return {};
}

/** Add one step's measured cost to the cycle counters. */
export function accrueStep(cycle: TaskCycle, usd: number, estimated: boolean): TaskCycle {
	return {
		...cycle,
		steps: cycle.steps + 1,
		usd: cycle.usd + Math.max(0, usd),
		usdEstimated: cycle.usdEstimated || estimated,
	};
}
