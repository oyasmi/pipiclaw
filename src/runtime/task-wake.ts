/**
 * Claiming a background job's or delegation run's completion wake before it may reopen a parked
 * task (spec 040, D7/T9). Pure functions over an explicit `event`/`workspaceDir`/owner, with no
 * dependency on `createRuntimeContext`'s closures.
 *
 * Trust comes from two things only: the producer-created `internalWake` envelope (DingTalk
 * inbound parsing never populates it, so user text or an external agent's stdout cannot forge
 * one), and the owner's `beginWakeConsumption`, which re-checks that the resource exists, has
 * settled, names this task, and that the dispatch id is exactly the one its own completion wake
 * carries.
 */
import type { ChannelEvent } from "../channel/channel-event.js";
import { getChannelDir } from "../channel/channel-paths.js";
import { readStoredTask, redeemTicket } from "../tasks/store.js";

/** The slice of `ChannelJobManager` / `SubAgentRunManager` a wake claim needs. */
export interface WakeOwner {
	beginWakeConsumption(id: string, taskId: string, dispatchId: string): Promise<boolean>;
	finishWakeConsumption(id: string, dispatchId: string): Promise<void>;
}

/** Test-only fault seam, kept for the restart/interrupt cases that exercise a failed write. */
export interface WakeTaskTransitionHooks {
	beforeActivation?: () => void;
}

export interface ClaimedWake {
	taskId: string;
	/** True when this wake redeemed the task's `work` ticket. */
	activated: boolean;
	/**
	 * True when it is safe to drop this wake without a turn even though it did not redeem a ticket
	 * itself: the task is already `open` and not paused, so some other wake in the same fan-out
	 * reopened it and the driver will pick up the result. Every other case — done, archived,
	 * paused, or the task missing — has nobody left to look at the result if it is dropped, so the
	 * caller must still route it to a normal turn. Always true when `activated` is true.
	 */
	taskStillDriven: boolean;
	/** Mark the wake consumed. Kept separate so the caller finalizes only after it accepted the turn. */
	finish(): Promise<void>;
}

async function isTaskActivelyDriven(channelDir: string, taskId: string): Promise<boolean> {
	const document = await readStoredTask(channelDir, taskId).catch(() => undefined);
	return document !== undefined && document.fields.state === "open" && !document.fields.paused;
}

/**
 * Claim a producer-created completion wake and redeem the task's ticket for it. Returns
 * `undefined` for an event with no (or an unverifiable) `internalWake`.
 *
 * Only a `work` ticket may be redeemed by a settling run or job (any bound run or job settling
 * wakes the leader, spec 052, D3): a task parked on a clock or a question to the user is not
 * waiting for it, and reopening it here would be exactly the unverified resumption path spec 051
 * exists to remove.
 */
export async function claimVerifiedWake(
	event: ChannelEvent,
	workspaceDir: string,
	owner: WakeOwner,
	hooks?: WakeTaskTransitionHooks,
): Promise<ClaimedWake | undefined> {
	const wake = event.internalWake;
	if (!wake || typeof event.dispatchId !== "string") return undefined;
	if (!(await owner.beginWakeConsumption(wake.resourceId, wake.taskId, event.dispatchId))) return undefined;
	const dispatchId = event.dispatchId;
	const channelDir = getChannelDir(workspaceDir, event.channelId);
	hooks?.beforeActivation?.();
	const redeemed = await redeemTicket(channelDir, wake.taskId, (ticket) => ticket.kind === "work");
	return {
		taskId: wake.taskId,
		activated: redeemed !== undefined,
		taskStillDriven: redeemed !== undefined || (await isTaskActivelyDriven(channelDir, wake.taskId)),
		finish: () => owner.finishWakeConsumption(wake.resourceId, dispatchId),
	};
}
