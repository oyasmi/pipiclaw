import type { TaskBudget, TaskState, TaskWaiting } from "./frontmatter.js";

/**
 * The port through which chat reaches the task lane (spec 064, D24): `/tasks`, the chat task tools
 * and the `/status` line all go through it. Defined down here so `tools/` and `commands/` never
 * import `runtime/`; the lane (`runtime/task-lane.ts`) implements it and the runner is handed the
 * implementation. Every write is made inside the task's own mutation lock and lands in the log
 * before the lane is told (INV-6).
 */

/** The step a running task is in the middle of. */
export interface TaskLiveStep {
	seq: number;
	startedAt: number;
	/** What the model is doing right now, one short line; absent between tool calls. */
	tool?: { summary: string; startedAt: number };
	toolsDone: number;
}

/** A delegation or job bound to the task and not yet settled. */
export interface TaskPendingWork {
	/** `run_…` for a delegation, a job id otherwise. */
	ref: string;
	kind: "delegation" | "job";
	/** The role (delegation) or the command (job). */
	label: string;
	startedAt: number;
	/** When an external run last produced output; absent when the owner cannot tell. */
	lastOutputAt?: number;
	/** Silent past the stall threshold (spec 064, D16). */
	stalled: boolean;
}

export interface TaskLiveSnapshot {
	id: string;
	state: TaskState;
	waiting?: TaskWaiting;
	/** The delivery channel is missing, not bound to this desk, or its transport is off (INV-7). */
	frozen: boolean;
	step?: TaskLiveStep;
	pending: TaskPendingWork[];
}

export type TaskMessageOutcome =
	| { kind: "not_found" }
	/** Delivered into the step that is running right now. */
	| { kind: "injected" }
	/** Recorded; the next step starts with it. */
	| { kind: "queued_for_next_step" }
	/** Recorded; it woke the task from a wait. */
	| { kind: "woke" }
	| { kind: "held_paused" }
	| { kind: "held_frozen" };

export type TaskControlOutcome = { kind: "ok" } | { kind: "not_found" } | { kind: "unchanged" };

export type TaskCancelOutcome = { kind: "cancelled"; cancelled: string[] } | { kind: "not_found" };

export interface TaskControl {
	/** A task was created outside the lane (`task_create`): look at the desk soon instead of at the next scan. */
	created(desk: string, id: string): void;
	/** One task, or every active task of the desk. */
	snapshot(desk: string, id?: string): Promise<TaskLiveSnapshot[]>;
	message(
		desk: string,
		id: string,
		input: { from: string; channel: string; text: string },
	): Promise<TaskMessageOutcome>;
	/** Stops the running step; in-flight delegations and jobs keep running and their results are recorded. */
	pause(desk: string, id: string, input: { by: "user"; reason: string }): Promise<TaskControlOutcome>;
	resume(desk: string, id: string, grants: Partial<TaskBudget>): Promise<TaskControlOutcome>;
	/** Stops the step, cancels the task's delegations and jobs, closes and archives. */
	cancel(desk: string, id: string, input: { by: "user"; note: string; channel?: string }): Promise<TaskCancelOutcome>;
}

/** What the leader registered during one step; the lane reads it when the step ends and derives the next state from it (D8). */
export interface TaskStepIntent {
	ask?: { question: string };
	/** The moment `task_wait` registered, as stored local-time text. */
	waitUntil?: string;
	close?: { outcome: "complete" | "cancel"; note: string };
	/** `task_report` calls this step, capped at {@link MAX_REPORTS_PER_STEP}. */
	reports: number;
}

export const MAX_REPORTS_PER_STEP = 3;

/**
 * What a task session's tools need from the lane: which step this is, where the step's intent is
 * recorded, and how to say something to the user. The tools only validate and write log records —
 * state is the lane's to derive (INV-2).
 */
export interface TaskSessionContext {
	taskId: string;
	/** The sequence number of the step that is running. */
	seq(): number;
	intent(): TaskStepIntent;
	/** Push text to the task's report channel; resolves whether it was delivered. */
	report(text: string): Promise<boolean>;
}
