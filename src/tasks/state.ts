import { formatLocalTime, parseLocalTime, parseWakeInput } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { checkBudget } from "./budget.js";
import type { TaskFrontmatter, TaskState, TaskWaiting } from "./frontmatter.js";
import {
	lastStep,
	stepEndsSinceResume,
	type TaskInputRecord,
	type TaskLogRecord,
	type TaskStepNext,
	type TaskStepReason,
	type TaskStepResult,
} from "./loop-log.js";

/**
 * Task state, derived from facts (spec 064, D7–D10, D16). Pure functions: no I/O, every input
 * explicit, so the whole transition table is testable without a runtime. The lane and
 * `tasks/store.ts` apply what these return; nothing here is a model-declared claim (INV-2).
 */

/** Consecutive `ok` steps that called no tool at all: the loop is talking to itself. */
export const IDLE_STEP_LIMIT = 2;
/** Consecutive steps that hit the step time limit. */
export const STEP_TIMEOUT_LIMIT = 2;
/** Consecutive steps that ended in an error. */
export const STEP_ERROR_LIMIT = 3;
/** `task_wait` accepts a moment between one minute and thirty days away. */
export const TASK_WAIT_MIN_MS = 60_000;
export const TASK_WAIT_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/** What the runtime observed about a step that just ended (D8). */
export interface StepFacts {
	result: TaskStepResult;
	/** `task_close` was called this step and the lane honoured it. */
	closed: boolean;
	/** The user paused the task while this step ran. */
	pausedByUser: boolean;
	asked?: { question: string };
	/** The moment `task_wait` registered (local-time text). */
	waitUntil?: string;
	/** Delegations and jobs bound to this task that have not settled. */
	pendingWork: number;
}

export interface StepDerivation {
	next: TaskStepNext;
	state: TaskState;
	waiting?: TaskWaiting;
	/** The task keeps its execution slot and runner (`continue`, `work`). */
	keepSlot: boolean;
}

/**
 * D8: the first rule that holds decides what the task does next. A `continue` after an `ok` step
 * stays `running` (the lane opens the next step at once); after a failed step it goes back to
 * `queued` so the lane can back off before re-admitting it.
 */
export function deriveAfterStep(facts: StepFacts, now: Date = new Date()): StepDerivation {
	const since = formatLocalTime(now);
	if (facts.closed) return { next: "closed", state: "queued", keepSlot: false };
	if (facts.pausedByUser) return { next: "paused", state: "paused", keepSlot: false };
	if (facts.asked) {
		return {
			next: "user",
			state: "waiting",
			waiting: { kind: "user", question: facts.asked.question, since },
			keepSlot: false,
		};
	}
	if (facts.waitUntil) {
		return {
			next: "time",
			state: "waiting",
			waiting: { kind: "time", until: facts.waitUntil, since },
			keepSlot: false,
		};
	}
	if (facts.pendingWork > 0) {
		return { next: "work", state: "waiting", waiting: { kind: "work", since }, keepSlot: true };
	}
	return { next: "continue", state: facts.result === "ok" ? "running" : "queued", keepSlot: true };
}

/** Why a step is starting, from the log: the first step, a resume, new input, a retry, or simply the next one. */
export function deriveStepReason(
	records: readonly TaskLogRecord[],
	inputs: readonly TaskInputRecord[],
): TaskStepReason {
	if (!records.some((record) => record.kind === "step")) return "start";
	if (inputs.some((input) => input.kind === "resume")) return "resume";
	if (inputs.length > 0) return "input";
	const lastEnd = [...records].reverse().find((record) => record.kind === "step_end");
	return lastEnd?.kind === "step_end" && lastEnd.result !== "ok" ? "retry" : "continue";
}

export type WaitingDecision = "stay" | "run" | "queue";

export interface WakeFacts {
	waiting: TaskWaiting;
	/** `newInputs(records)` for this task. */
	inputs: readonly TaskLogRecord[];
	pendingWork: number;
	now: number;
}

/**
 * D7/D9: whether a waiting task wakes. New input wakes it — except that a task waiting for the user
 * wakes only for a `message`, so a result that arrives meanwhile does not re-ask an unanswered
 * question. `run` reuses the slot and runner (work waits hold them); `queue` goes back to the line.
 */
export function evaluateWaiting(facts: WakeFacts): WaitingDecision {
	const { waiting, inputs } = facts;
	switch (waiting.kind) {
		case "user":
			return inputs.some((record) => record.kind === "message") ? "queue" : "stay";
		case "time": {
			if (inputs.length > 0) return "queue";
			const until = parseLocalTime(waiting.until);
			return until !== undefined && until > facts.now ? "stay" : "queue";
		}
		case "work":
			if (inputs.length > 0) return "run";
			// Whatever it waited for has vanished without a settlement record: nothing can wake it.
			return facts.pendingWork === 0 ? "queue" : "stay";
	}
}

export interface BootReconciliation {
	fields: TaskFrontmatter;
	/** The interrupted step's `step_end`, when one has to be written. */
	appendStepEnd?: { seq: number; next: TaskStepNext };
}

/**
 * D10: a runtime start finds tasks in whatever state the previous process left. `running` means the
 * process died mid-step (or between the step's end record and its state write): record the
 * interruption if the log lacks it and derive the next state as if the step had ended; a work wait
 * with nothing in flight goes back to the line. Writes state and log only — no model call.
 */
export function reconcileOnBoot(
	fields: TaskFrontmatter,
	records: readonly TaskLogRecord[],
	pendingWork: number,
	now: Date = new Date(),
): BootReconciliation | undefined {
	if (fields.state === "running") {
		const last = lastStep(records);
		const derivation = deriveAfterStep(
			{ result: "interrupted", closed: false, pausedByUser: false, pendingWork },
			now,
		);
		const next: TaskFrontmatter = {
			...fields,
			state: derivation.state === "running" ? "queued" : derivation.state,
			waiting: derivation.waiting,
		};
		if (last && !last.ended) {
			const usage = fields.usage;
			if (usage)
				next.usage = { ...usage, steps: usage.steps + 1, unknownCostCount: (usage.unknownCostCount ?? 0) + 1 };
			return { fields: next, appendStepEnd: { seq: last.step.seq, next: derivation.next } };
		}
		return { fields: next };
	}
	if (fields.state === "waiting" && fields.waiting?.kind === "work" && pendingWork === 0) {
		return { fields: { ...fields, state: "queued", waiting: undefined } };
	}
	return undefined;
}

export type GuardBreach = "steps" | "usd" | "idle" | "timeout" | "error";

export interface GuardVerdict {
	breach: GuardBreach;
	/** The reason as the user reads it (a runtime receipt). */
	reason: string;
}

/**
 * D16: the stops the runtime enforces on a task about to run again. Everything is read from the
 * persisted state and log, so a restart does not forget a streak. Streaks count only the steps
 * since the user last resumed the task. Budget is checked first — it is the one the user can
 * fix with a number.
 */
export function checkGuards(fields: TaskFrontmatter, records: readonly TaskLogRecord[]): GuardVerdict | undefined {
	const budget = checkBudget(fields);
	if (budget.breach && budget.reason) return { breach: budget.breach, reason: budget.reason };

	const ends = stepEndsSinceResume(records);
	const tail = (count: number) => ends.slice(-count);

	const idle = tail(IDLE_STEP_LIMIT);
	if (idle.length === IDLE_STEP_LIMIT && idle.every((end) => end.result === "ok" && end.tools.length === 0)) {
		return { breach: "idle", reason: `连续 ${IDLE_STEP_LIMIT} 步没有任何工具调用，已停下等你确认` };
	}
	const timeouts = tail(STEP_TIMEOUT_LIMIT);
	if (timeouts.length === STEP_TIMEOUT_LIMIT && timeouts.every((end) => end.result === "timeout")) {
		return { breach: "timeout", reason: `连续 ${STEP_TIMEOUT_LIMIT} 步超过单步时限被中止` };
	}
	const errors = tail(STEP_ERROR_LIMIT);
	if (errors.length === STEP_ERROR_LIMIT && errors.every((end) => end.result === "error")) {
		return { breach: "error", reason: `连续 ${STEP_ERROR_LIMIT} 步出错` };
	}
	return undefined;
}

/**
 * Parse `task_wait`'s `until`: `+30m` / `+2h` / `+1d` or a local timestamp. The moment must lie
 * between one minute and thirty days ahead. Returns the canonical local-time text to store.
 */
export function parseWaitUntil(raw: string, now: Date = new Date()): string {
	const atMs = parseWakeInput(raw, now);
	if (atMs === undefined) {
		throw new RecoverableToolError(
			`until "${raw}" is not a valid local time or relative offset (e.g. +30m, +2h, +1d, 2026-10-30T09:00:00+08:00).`,
		);
	}
	const delta = atMs - now.getTime();
	if (delta < TASK_WAIT_MIN_MS) {
		throw new RecoverableToolError(
			`until "${raw}" is less than a minute away. To keep working, just end the step without task_wait.`,
		);
	}
	if (delta > TASK_WAIT_MAX_MS) {
		throw new RecoverableToolError(
			`until "${raw}" is more than 30 days away. Pick an earlier moment and check again then.`,
		);
	}
	return formatLocalTime(new Date(atMs));
}
