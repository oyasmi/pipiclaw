import { describe, expect, it } from "vitest";
import { checkBudget, DEFAULT_TASK_BUDGET, effectiveBudget } from "../src/tasks/budget.js";
import type { TaskFrontmatter, TaskUsage } from "../src/tasks/frontmatter.js";
import type { TaskLogRecord, TaskStepResult } from "../src/tasks/loop-log.js";
import {
	checkGuards,
	deriveAfterStep,
	deriveStepReason,
	evaluateWaiting,
	IDLE_STEP_LIMIT,
	parseWaitUntil,
	reconcileOnBoot,
	STEP_ERROR_LIMIT,
	STEP_TIMEOUT_LIMIT,
	type StepFacts,
} from "../src/tasks/state.js";

const NOW = new Date("2026-10-28T10:00:00+08:00");
const TS = "2026-10-28T09:00:00+08:00";

function usage(overrides: Partial<TaskUsage> = {}): TaskUsage {
	return { startedAt: TS, steps: 0, usd: 0, usdEstimated: false, ...overrides };
}

function facts(overrides: Partial<StepFacts> = {}): StepFacts {
	return { result: "ok", closed: false, pausedByUser: false, pendingWork: 0, ...overrides };
}

const step = (seq: number): TaskLogRecord => ({ ts: TS, kind: "step", seq, reason: "continue", brief: "delta" });
const stepEnd = (seq: number, result: TaskStepResult = "ok", tools: string[] = ["bash"]): TaskLogRecord => ({
	ts: TS,
	kind: "step_end",
	seq,
	result,
	next: "continue",
	note: "n",
	tools,
});
const settle = (ref: string): TaskLogRecord => ({ ts: TS, kind: "settle", ref, status: "completed" });
const message = (): TaskLogRecord => ({ ts: TS, kind: "message", from: "u", channel: "c", text: "hi" });

describe("what a step ends in (D8)", () => {
	it("takes the first rule that holds: close, user pause, ask, wait, work in flight, continue", () => {
		const all = facts({
			closed: true,
			pausedByUser: true,
			asked: { question: "q?" },
			waitUntil: "2026-10-29T10:00:00+08:00",
			pendingWork: 2,
		});
		expect(deriveAfterStep(all, NOW).next).toBe("closed");
		expect(deriveAfterStep({ ...all, closed: false }, NOW).next).toBe("paused");
		expect(deriveAfterStep({ ...all, closed: false, pausedByUser: false }, NOW)).toMatchObject({
			next: "user",
			waiting: { kind: "user", question: "q?" },
			keepSlot: false,
		});
		expect(deriveAfterStep({ ...all, closed: false, pausedByUser: false, asked: undefined }, NOW)).toMatchObject({
			next: "time",
			waiting: { kind: "time", until: "2026-10-29T10:00:00+08:00" },
		});
		expect(deriveAfterStep(facts({ pendingWork: 1 }), NOW)).toMatchObject({
			next: "work",
			state: "waiting",
			keepSlot: true,
		});
	});

	it("keeps running after a good step but goes back in line after a failed one", () => {
		expect(deriveAfterStep(facts(), NOW)).toMatchObject({ next: "continue", state: "running" });
		for (const result of ["error", "timeout", "aborted", "interrupted"] as const) {
			expect(deriveAfterStep(facts({ result }), NOW)).toMatchObject({ next: "continue", state: "queued" });
		}
	});
});

describe("what wakes a waiting task (D9)", () => {
	const since = TS;
	const now = NOW.getTime();

	it("lets news reach a work wait, and a vanished wait go back in line", () => {
		const waiting = { kind: "work" as const, since };
		expect(evaluateWaiting({ waiting, inputs: [], pendingWork: 1, now })).toBe("stay");
		expect(evaluateWaiting({ waiting, inputs: [settle("a")], pendingWork: 1, now })).toBe("run");
		expect(evaluateWaiting({ waiting, inputs: [], pendingWork: 0, now })).toBe("queue");
	});

	it("wakes a user wait only for a message — a result must not make it ask the same question twice", () => {
		const waiting = { kind: "user" as const, question: "q", since };
		expect(evaluateWaiting({ waiting, inputs: [settle("a")], pendingWork: 0, now })).toBe("stay");
		expect(evaluateWaiting({ waiting, inputs: [settle("a"), message()], pendingWork: 0, now })).toBe("queue");
	});

	it("wakes a time wait when due or on any input, not before", () => {
		const waiting = { kind: "time" as const, until: "2026-10-28T12:00:00+08:00", since };
		expect(evaluateWaiting({ waiting, inputs: [], pendingWork: 0, now })).toBe("stay");
		expect(evaluateWaiting({ waiting, inputs: [message()], pendingWork: 0, now })).toBe("queue");
		expect(
			evaluateWaiting({ waiting, inputs: [], pendingWork: 0, now: Date.parse("2026-10-28T12:00:01+08:00") }),
		).toBe("queue");
	});
});

describe("why a step starts", () => {
	it("is told from the log: first step, new input, a resume, a retry after a failure, or just the next one", () => {
		const reason = (records: TaskLogRecord[], inputs: Parameters<typeof deriveStepReason>[1] = []) =>
			deriveStepReason(records, inputs);
		expect(reason([])).toBe("start");
		expect(reason([step(1), stepEnd(1)])).toBe("continue");
		expect(reason([step(1), stepEnd(1, "error")])).toBe("retry");
		expect(reason([step(1), stepEnd(1)], [settle("a") as never])).toBe("input");
		expect(reason([step(1), stepEnd(1)], [{ ts: TS, kind: "resume" }, settle("a") as never])).toBe("resume");
	});
});

describe("restart reconciliation (D10)", () => {
	const fields = (extra: Partial<TaskFrontmatter>): TaskFrontmatter => ({
		state: "running",
		usage: usage(),
		...extra,
	});

	it("records the interrupted step once and derives the next state from what is in flight", () => {
		const interrupted = reconcileOnBoot(fields({}), [step(1)], 1, NOW);
		expect(interrupted?.appendStepEnd).toEqual({ seq: 1, next: "work" });
		expect(interrupted?.fields).toMatchObject({ state: "waiting", waiting: { kind: "work" }, usage: { steps: 1 } });
		expect(reconcileOnBoot(fields({}), [step(1)], 0, NOW)?.fields.state).toBe("queued");
		// Crashed between the `step_end` record and the state write: no second record, no double count.
		const written = reconcileOnBoot(fields({}), [step(1), stepEnd(1)], 0, NOW);
		expect(written?.appendStepEnd).toBeUndefined();
		expect(written?.fields.usage?.steps).toBe(0);
	});

	it("returns a work wait with nothing in flight to the line and leaves the other states alone", () => {
		const waiting = fields({ state: "waiting", waiting: { kind: "work", since: TS } });
		expect(reconcileOnBoot(waiting, [], 0, NOW)?.fields).toMatchObject({ state: "queued" });
		expect(reconcileOnBoot(waiting, [], 1, NOW)).toBeUndefined();
		expect(reconcileOnBoot(fields({ state: "queued" }), [], 0, NOW)).toBeUndefined();
	});
});

describe("runtime guards (D16)", () => {
	const base: TaskFrontmatter = { state: "queued", usage: usage() };

	it("stops on budget in either dimension, checked first", () => {
		expect(checkBudget({ state: "queued" })).toEqual({});
		expect(effectiveBudget({ ...base, budget: { steps: 3 } })).toEqual({ ...DEFAULT_TASK_BUDGET, steps: 3 });
		expect(checkGuards({ ...base, usage: usage({ steps: DEFAULT_TASK_BUDGET.steps }) }, [])?.breach).toBe("steps");
		const estimated = checkGuards({ ...base, usage: usage({ usd: 25, usdEstimated: true }) }, []);
		expect(estimated).toMatchObject({ breach: "usd" });
		expect(estimated?.reason).toContain("估算");
	});

	it("stops exactly at the idle, timeout and error streak limits, and a good step breaks the streak", () => {
		const idle = (seq: number) => stepEnd(seq, "ok", []);
		expect(IDLE_STEP_LIMIT).toBe(2);
		expect(checkGuards(base, [idle(1)])).toBeUndefined();
		expect(checkGuards(base, [idle(1), idle(2)])?.breach).toBe("idle");
		expect(checkGuards(base, [idle(1), stepEnd(2), idle(3)])).toBeUndefined();

		const times = Array.from({ length: STEP_TIMEOUT_LIMIT }, (_, i) => stepEnd(i + 1, "timeout"));
		expect(checkGuards(base, times.slice(1))).toBeUndefined();
		expect(checkGuards(base, times)?.breach).toBe("timeout");

		const errors = Array.from({ length: STEP_ERROR_LIMIT }, (_, i) => stepEnd(i + 1, "error"));
		expect(checkGuards(base, errors.slice(1))).toBeUndefined();
		expect(checkGuards(base, errors)?.breach).toBe("error");
	});

	it("counts only the steps since the user resumed, so one look from the user is enough", () => {
		const resume: TaskLogRecord = { ts: TS, kind: "resume" };
		const idle = [stepEnd(1, "ok", []), stepEnd(2, "ok", [])];
		expect(checkGuards(base, idle)?.breach).toBe("idle");
		expect(checkGuards(base, [...idle, resume])).toBeUndefined();
		expect(checkGuards(base, [...idle, resume, stepEnd(3, "ok", [])])).toBeUndefined();
	});
});

describe("task_wait's moment (D22)", () => {
	it("accepts a relative offset or a timestamp between one minute and thirty days ahead", () => {
		expect(parseWaitUntil("+2h", NOW)).toContain("2026-10-28T12:00");
		expect(() => parseWaitUntil("+30s", NOW)).toThrow(/less than a minute/);
		expect(() => parseWaitUntil("+31d", NOW)).toThrow(/30 days/);
		expect(() => parseWaitUntil("tomorrow-ish", NOW)).toThrow(/not a valid/);
	});
});
