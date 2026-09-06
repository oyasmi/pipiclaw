import { describe, expect, it } from "vitest";
import { accrueStep, checkBudget, DEFAULT_TASK_BUDGET, effectiveBudget } from "../src/tasks/budget.js";
import type { TaskCycle, TaskFrontmatterV4 } from "../src/tasks/frontmatter.js";

const NOW = new Date("2026-09-05T12:00:00+08:00");

function cycle(overrides: Partial<TaskCycle> = {}): TaskCycle {
	return {
		id: "c-2026-09-05",
		startedAt: "2026-09-05T11:00:00+08:00",
		steps: 0,
		rounds: 0,
		usd: 0,
		usdEstimated: false,
		expired: 0,
		...overrides,
	};
}

function task(overrides: Partial<TaskFrontmatterV4> = {}): TaskFrontmatterV4 {
	return { state: "open", cycle: cycle(), ...overrides };
}

describe("cycle budget (spec 051, D6)", () => {
	it("passes a fresh cycle and merges per-task overrides onto the defaults", () => {
		expect(checkBudget(task(), NOW)).toEqual({});
		expect(effectiveBudget(task({ budget: { steps: 3 } }))).toEqual({ ...DEFAULT_TASK_BUDGET, steps: 3 });
	});

	it("breaches on each of the four dimensions independently", () => {
		expect(checkBudget(task({ cycle: cycle({ steps: 40 }) }), NOW).breach).toBe("steps");
		expect(checkBudget(task({ cycle: cycle({ rounds: 4 }) }), NOW).breach).toBe("rounds");
		expect(checkBudget(task({ cycle: cycle({ usd: 8 }) }), NOW).breach).toBe("usd");
		// Started 1h ago; a 30-minute wall budget is already spent.
		expect(checkBudget(task({ budget: { wallMin: 30 } }), NOW).breach).toBe("wallMin");
		expect(checkBudget(task({ budget: { until: "2026-09-05T11:30:00+08:00" } }), NOW).breach).toBe("until");
	});

	it("names the breach in a reason the receipt can show the user verbatim", () => {
		const status = checkBudget(task({ cycle: cycle({ usd: 9, usdEstimated: true }) }), NOW);
		expect(status.reason).toContain("$9.00");
		// The user needs to know a stop was driven by an estimate, not a measured cost (D10).
		expect(status.reason).toContain("估算");
	});

	it("ignores every dimension for a task that has no cycle open yet", () => {
		expect(checkBudget({ state: "open" }, NOW)).toEqual({});
	});

	it("accrues a step's cost and latches the estimated flag", () => {
		const first = accrueStep(cycle(), 1.25, false);
		expect(first).toMatchObject({ steps: 1, usd: 1.25, usdEstimated: false });
		const second = accrueStep(first, 0.5, true);
		expect(second).toMatchObject({ steps: 2, usd: 1.75, usdEstimated: true });
		// Once any part of the total is an estimate the whole total is, and stays, an estimate.
		expect(accrueStep(second, 0.1, false).usdEstimated).toBe(true);
	});
});
