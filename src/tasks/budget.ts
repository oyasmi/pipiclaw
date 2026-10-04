import { formatLocalTime } from "../shared/local-time.js";
import type { TaskBudget, TaskFrontmatter, TaskUsage } from "./frontmatter.js";

/**
 * The task budget (spec 051, D6; narrowed by spec 052, D8) — what replaced the governor.
 *
 * Two numbers the task carries, the loop spends, and the user can see and top up. They count the
 * whole project (one task is one project) and include the cost of delegations bound to it, which
 * is where most of a leader's spend goes. When one runs out the task stops and says so — no
 * guessing about whether the work was real.
 */
export const DEFAULT_TASK_BUDGET: TaskBudget = {
	steps: 60,
	usd: 20,
};

/** Two consecutive steps that called no tool at all: the loop is talking to itself. */
export const IDLE_STEP_LIMIT = 2;

export function effectiveBudget(fields: TaskFrontmatter): TaskBudget {
	return { ...DEFAULT_TASK_BUDGET, ...fields.budget };
}

export type BudgetBreach = "steps" | "usd";

export interface BudgetStatus {
	breach?: BudgetBreach;
	reason?: string;
}

/**
 * Whether the task has run out of either dimension. Checked before a step is queued, so a task
 * that is already over budget never spends one more model call to find out.
 */
export function checkBudget(fields: TaskFrontmatter): BudgetStatus {
	const usage = fields.usage;
	if (!usage) return {};
	const budget = effectiveBudget(fields);

	if (usage.steps >= budget.steps) {
		return { breach: "steps", reason: `已用满 ${budget.steps} 步` };
	}
	if (usage.usd >= budget.usd) {
		const estimated = usage.usdEstimated ? "（含估算）" : "";
		return { breach: "usd", reason: `成本已达 $${usage.usd.toFixed(2)}${estimated}（上限 $${budget.usd}）` };
	}
	return {};
}

/** Fresh counters for a newly created task. */
export function createUsage(now: Date = new Date()): TaskUsage {
	return { startedAt: formatLocalTime(now), steps: 0, usd: 0, usdEstimated: false, expired: 0 };
}
