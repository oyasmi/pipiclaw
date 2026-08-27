/**
 * Verifying and claiming a background job's or delegation run's completion wake before it may
 * activate a parked task (spec 040, D7/T9). Split out of `bootstrap.ts`: these are pure functions
 * over an explicit `event`/`workspaceDir`/`executor`, with no dependency on
 * `createRuntimeContext`'s closures.
 */
import { getChannelJobManager, type JobSnapshot } from "../agent/job-manager.js";
import type { Executor } from "../executor.js";
import { getSubAgentRunManager, type RunRecord } from "../subagents/runs.js";
import {
	activateWaitingTask,
	readStoredTask,
	rollbackWaitingTask,
	type WakeTaskTransitionHooks,
} from "../tasks/store.js";
import { normalizeStoredStatus } from "../tasks/transitions.js";
import type { ChannelEvent } from "./channel-event.js";
import { getChannelDir } from "./channel-paths.js";

/**
 * True when `taskId` is currently `active` and enabled — i.e. the task driver already owns
 * advancing it. A completion wake that could not activate the task (because it was not
 * `waiting`) is safe to drop without spending an agent turn only in this case: some other wake in
 * the same fan-out already activated it, and the driver will pick up the result. Every other case
 * — `done`, archived, disabled, or the task missing entirely — has nobody left to look at the
 * wake's result if it is dropped here, so the caller must still route it to a normal turn.
 */
async function isTaskActivelyDriven(channelDir: string, taskId: string): Promise<boolean> {
	const document = await readStoredTask(channelDir, taskId, false, true).catch(() => undefined);
	return (
		document !== undefined &&
		normalizeStoredStatus(document.fields.status) === "active" &&
		document.fields.enabled !== false
	);
}

/**
 * Whether a `[JOB:<jobId>] ... belongs to task <taskId>.` wake actually names a job that: exists
 * on this channel, has actually finished (a still-`running` job cannot have produced this wake —
 * accepting it anyway would let a message merely mentioning a live job's id activate a task
 * early), and really is the one whose own contract names `taskId` (spec 040, T9). The text itself
 * is never sufficient — it can be typed by any user, or echoed back by an external agent's own
 * untrusted stdout.
 */
export function isVerifiedJobWake(jobs: JobSnapshot[], jobId: string, taskId: string): boolean {
	const job = jobs.find((candidate) => candidate.id === jobId);
	return job !== undefined && job.status !== "running" && job.taskId === taskId;
}

/**
 * Same check as `isVerifiedJobWake`, for a `[SUBAGENT:<runId>] ... belongs to task <taskId>.`
 * delegation wake. `settledAt` (rather than `status !== "running"`) is the terminal marker here
 * because it is published with the terminal record before usage/archive/wake side effects — the
 * same idempotency guard the manager itself relies on. A pending settlement intent leaves it unset.
 */
export function isVerifiedDelegationWake(record: RunRecord | undefined, taskId: string): boolean {
	return record !== undefined && record.settledAt !== undefined && record.taskId === taskId;
}

/** Plain wake text is untrusted. Only an event carrying the producer-created structured envelope
 * and its exact durable dispatch id may enter task activation; normal DingTalk inbound events do
 * not populate `internalWake`, so copying a real wake's text is insufficient. */
export function isTrustedInternalWake(
	event: ChannelEvent,
	kind: "job" | "subagent",
	resourceId: string,
	taskId: string,
): event is ChannelEvent & { dispatchId: string } {
	const wake = event.internalWake;
	return (
		wake?.kind === kind &&
		wake.resourceId === resourceId &&
		wake.taskId === taskId &&
		typeof event.dispatchId === "string" &&
		wake.dispatchId === event.dispatchId
	);
}

export interface ClaimedDelegationWake {
	taskId: string;
	activated: boolean;
	/** True when it is safe to drop this wake without a turn even though it did not activate the
	 *  task itself — see `isTaskActivelyDriven`. Always true when `activated` is true. */
	taskStillDriven: boolean;
	finish(): Promise<void>;
	rollback(): Promise<void>;
}

/** Claim and activate a producer-created delegation wake without consuming it yet. Keeping the
 * final marker separate lets transports such as TUI mark it consumed only after they have accepted
 * the corresponding turn; a rejected submit remains replayable in the same or next process. */
export async function claimVerifiedDelegationWake(
	event: ChannelEvent,
	workspaceDir: string,
	hooks?: WakeTaskTransitionHooks,
): Promise<ClaimedDelegationWake | undefined> {
	const wake = event.internalWake;
	if (wake?.kind !== "subagent") return undefined;
	const runManager = getSubAgentRunManager(event.channelId);
	const record = runManager.get(wake.resourceId);
	if (
		!isTrustedInternalWake(event, "subagent", wake.resourceId, wake.taskId) ||
		!isVerifiedDelegationWake(record, wake.taskId) ||
		!(await runManager.beginWakeConsumption(wake.resourceId, wake.taskId, event.dispatchId))
	) {
		return undefined;
	}
	const channelDir = getChannelDir(workspaceDir, event.channelId);
	const activated = await activateWaitingTask(channelDir, wake.taskId, hooks);
	const taskStillDriven = activated !== undefined || (await isTaskActivelyDriven(channelDir, wake.taskId));
	return {
		taskId: wake.taskId,
		activated: activated !== undefined,
		taskStillDriven,
		finish: async () => {
			await runManager.finishWakeConsumption(wake.resourceId, event.dispatchId);
		},
		rollback: () => rollbackWaitingTask(channelDir, wake.taskId, "external-signal"),
	};
}

export interface ClaimedJobWake {
	taskId: string;
	activated: boolean;
	/** See `ClaimedDelegationWake.taskStillDriven`. */
	taskStillDriven: boolean;
	finish(): Promise<void>;
}

/** Same shape as `claimVerifiedDelegationWake`, for a `[JOB:<jobId>] ... belongs to task
 * <taskId>.` completion wake. A background job has no rollback bookkeeping — its wake
 * activation is a single unconditional step — so `ClaimedJobWake` omits `rollback`. */
export async function claimVerifiedJobWake(
	event: ChannelEvent,
	workspaceDir: string,
	executor: Executor,
	hooks?: WakeTaskTransitionHooks,
): Promise<ClaimedJobWake | undefined> {
	const wake = event.internalWake;
	if (wake?.kind !== "job") return undefined;
	const jobManager = getChannelJobManager(event.channelId, executor);
	const jobs = await jobManager.list();
	if (
		!isTrustedInternalWake(event, "job", wake.resourceId, wake.taskId) ||
		!isVerifiedJobWake(jobs, wake.resourceId, wake.taskId) ||
		!(await jobManager.beginWakeConsumption(wake.resourceId, wake.taskId, event.dispatchId))
	) {
		return undefined;
	}
	const channelDir = getChannelDir(workspaceDir, event.channelId);
	const activated = await activateWaitingTask(channelDir, wake.taskId, hooks);
	const taskStillDriven = activated !== undefined || (await isTaskActivelyDriven(channelDir, wake.taskId));
	return {
		taskId: wake.taskId,
		activated: activated !== undefined,
		taskStillDriven,
		finish: async () => {
			await jobManager.finishWakeConsumption(wake.resourceId, event.dispatchId);
		},
	};
}
