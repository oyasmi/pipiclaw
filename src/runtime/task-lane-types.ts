import type { AgentRunner } from "../agent/types.js";
import type { ChannelStore } from "../channel/store.js";
import type { DeskJobManager } from "../jobs/manager.js";
import type { SubAgentRunManager } from "../subagents/runs.js";
import type { TaskSessionContext, TaskStepIntent } from "../tasks/control.js";

/** Executing tasks per desk and per daemon (spec 064, D12). Code constants, not settings. */
export const MAX_EXECUTING_TASKS_PER_DESK = 3;
export const MAX_EXECUTING_TASKS = 5;
/** One step may run this long before it is stopped (D14). */
export const STEP_TIME_LIMIT_MS = 20 * 60_000;
/** The longest the lane sleeps between scans (D11). */
export const MAX_SLEEP_MS = 15 * 60_000;
/** A burst of notifications collapses into one rescan. */
export const NOTIFY_DEBOUNCE_MS = 50;
/** Waiting before a task is admitted again after its first and second consecutive error (D16). */
export const ERROR_BACKOFF_MS: readonly number[] = [60_000, 5 * 60_000];

export interface TaskStepEvent {
	phase: "started" | "ended";
	desk: string;
	taskId: string;
	seq: number;
	/** `ended` only. */
	result?: string;
	/** `ended` only: what the task does next (`continue` / `work` / `user` / `time` / `closed` / `paused`). */
	next?: string;
}

export interface TaskRunnerTarget {
	desk: string;
	deskDir: string;
	taskId: string;
	/** The task's report channel: delegation notices, `send_media` and audit land there. */
	channelId: string;
	session: TaskSessionContext;
}

export interface TaskLaneOptions {
	/** The desks the lane scans — the active ones (spec 058, D6). A dormant desk's tasks are never touched. */
	getActiveDesks: () => ReadonlyArray<{ desk: string; deskDir: string }>;
	/** The directory of a desk the runtime knows, or `undefined`. */
	getDeskDir: (desk: string) => string | undefined;
	/**
	 * Whether a report channel is bound to a desk right now. A task whose `channel` is missing or not
	 * bound to its own desk is frozen: the lane does not touch it (INV-7).
	 */
	isBoundTo: (channelId: string, desk: string) => boolean;
	/** Whether the channel's transport is switched on in this process (spec 061, INV-8). */
	isReachable: (channelId: string) => boolean;
	/** Build the runner for one task (the `task` profile). The lane owns it from here and disposes it. */
	createTaskRunner: (target: TaskRunnerTarget) => AgentRunner;
	getRuns: (desk: string) => SubAgentRunManager;
	getJobs: (desk: string) => DeskJobManager;
	store: ChannelStore;
	/** Say something to a report channel without a model; resolves whether it was delivered. */
	deliver: (desk: string, channelId: string, text: string) => Promise<boolean>;
	/** `tools.tasks.enabled`, re-read on every scan. Off: no new steps, maintenance continues. */
	isEnabled?: () => boolean;
	/** Steps in flight register here so shutdown can wait for them. */
	activeTasks: Set<Promise<void>>;
	/** Observability only (evaluation workers, tests): a step began or ended. Must not throw into the lane. */
	onStep?: (event: TaskStepEvent) => void;
	now?: () => number;
	/** Test overrides for the timing constants. */
	timing?: Partial<{
		stepTimeLimitMs: number;
		maxSleepMs: number;
		notifyDebounceMs: number;
		errorBackoffMs: readonly number[];
	}>;
}

export type StepAbort = "pause" | "cancel" | "timeout" | "shutdown";

/** What the lane holds in memory for a task it is executing. Everything durable lives in the task's files. */
export interface LiveTask {
	key: string;
	desk: string;
	deskDir: string;
	taskId: string;
	channelId: string;
	runner?: AgentRunner;
	/** The sequence number of the step that is running (or ran last). */
	seq: number;
	/** What the leader registered during the step that is running. */
	intent: TaskStepIntent;
	step?: { seq: number; startedAt: number; abort?: StepAbort; timer?: ReturnType<typeof setTimeout> };
	/** A drive loop is running for this task (a step may or may not be in flight at the moment). */
	driving: boolean;
}

/** What the step, control and scan code share. The lane builds one and hands it around; nothing here is a collaborator of its own. */
export interface LaneContext {
	options: TaskLaneOptions;
	live: Map<string, LiveTask>;
	now(): number;
	timing: { stepTimeLimitMs: number; maxSleepMs: number; notifyDebounceMs: number; errorBackoffMs: readonly number[] };
	/** Ask for a rescan soon (debounced). */
	notify(): void;
	/** Dispose a task's runner and forget its in-memory state, unless a drive loop still owns it. */
	release(live: LiveTask): Promise<void>;
	/** Whether the lane has been stopped. */
	isStopped(): boolean;
}

export function taskKey(desk: string, taskId: string): string {
	return `${desk}\0${taskId}`;
}
