import { describe, expect, it } from "vitest";
import { checkBudget, DEFAULT_TASK_BUDGET, effectiveBudget } from "../src/tasks/budget.js";
import type { TaskFrontmatter, TaskUsage } from "../src/tasks/frontmatter.js";

function usage(overrides: Partial<TaskUsage> = {}): TaskUsage {
	return { startedAt: "2026-09-05T11:00:00+08:00", steps: 0, usd: 0, usdEstimated: false, expired: 0, ...overrides };
}

function task(overrides: Partial<TaskFrontmatter> = {}): TaskFrontmatter {
	return { state: "open", usage: usage(), ...overrides };
}

describe("task budget (spec 052, D8)", () => {
	it("passes a fresh task and merges per-task overrides onto the defaults", () => {
		expect(checkBudget(task())).toEqual({});
		expect(effectiveBudget(task({ budget: { steps: 3 } }))).toEqual({ ...DEFAULT_TASK_BUDGET, steps: 3 });
	});

	it("breaches on each dimension independently", () => {
		expect(checkBudget(task({ usage: usage({ steps: DEFAULT_TASK_BUDGET.steps }) })).breach).toBe("steps");
		expect(checkBudget(task({ usage: usage({ usd: DEFAULT_TASK_BUDGET.usd }) })).breach).toBe("usd");
		expect(checkBudget(task({ budget: { steps: 2 }, usage: usage({ steps: 2 }) })).breach).toBe("steps");
	});

	it("tells the user a stop was driven by an estimate rather than a measured cost", () => {
		const status = checkBudget(task({ usage: usage({ usd: 25, usdEstimated: true }) }));
		expect(status.reason).toContain("$25.00");
		expect(status.reason).toContain("估算");
	});

	it("ignores a task whose usage clock has not started", () => {
		expect(checkBudget({ state: "open" })).toEqual({});
	});
});
