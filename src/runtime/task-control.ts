import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { extractTaskTitle, readActiveTasks } from "../tasks/contract.js";
import type {
	TaskCancelOutcome,
	TaskControl,
	TaskControlOutcome,
	TaskLiveSnapshot,
	TaskMessageOutcome,
} from "../tasks/control.js";
import type { TaskBudget, TaskFrontmatter } from "../tasks/frontmatter.js";
import { appendTaskLog } from "../tasks/loop-log.js";
import { cancelledByUserReceipt } from "../tasks/receipts.js";
import {
	closeTask as closeStoredTask,
	pauseTask as pauseStoredTask,
	readStoredTask,
	resumeTask as resumeStoredTask,
	tasksDir,
} from "../tasks/store.js";
import { describeToolCall } from "../tools/contract/presentation.js";
import { type LaneContext, taskKey } from "./task-lane-types.js";
import { listPendingWork } from "./task-pending.js";
import { abortStep } from "./task-step.js";

/** Whether a task's report channel can currently be reached (INV-7). */
export function isFrozen(ctx: LaneContext, desk: string, fields: TaskFrontmatter): boolean {
	const channel = fields.channel;
	return !channel || !ctx.options.isBoundTo(channel, desk) || !ctx.options.isReachable(channel);
}

/**
 * The chat-facing control surface of the lane (spec 064, D24): every write is made inside the
 * task's own mutation lock (the store's transitions take it), appended to the log before the lane is
 * told, and answered with what actually happened to the task.
 */
export class LaneControl implements TaskControl {
	constructor(private readonly ctx: LaneContext) {}

	created(): void {
		this.ctx.notify();
	}

	async snapshot(desk: string, id?: string): Promise<TaskLiveSnapshot[]> {
		const { ctx } = this;
		const deskDir = ctx.options.getDeskDir(desk);
		if (!deskDir) return [];
		const now = ctx.now();
		const entries = (await readActiveTasks(tasksDir(deskDir))).filter(
			(entry) => !entry.fields.outcome && (id === undefined || entry.id === id),
		);
		if (entries.length === 0) return [];
		const pending = await listPendingWork(ctx.options, desk, now, true);
		return entries.map((entry) => {
			const live = ctx.live.get(taskKey(desk, entry.id));
			const activity = live?.runner?.getActivity();
			const current = activity?.pendingTools[0];
			return {
				id: entry.id,
				state: entry.fields.state,
				...(entry.fields.waiting ? { waiting: entry.fields.waiting } : {}),
				frozen: isFrozen(ctx, desk, entry.fields),
				...(live?.step
					? {
							step: {
								seq: live.step.seq,
								startedAt: live.step.startedAt,
								toolsDone: activity?.toolsDone ?? 0,
								...(current
									? {
											tool: {
												summary: describeToolCall(current.toolName, current.args),
												startedAt: current.startTime,
											},
										}
									: {}),
							},
						}
					: {}),
				pending: pending.get(entry.id) ?? [],
			};
		});
	}

	async message(
		desk: string,
		id: string,
		input: { from: string; channel: string; text: string },
	): Promise<TaskMessageOutcome> {
		const { ctx } = this;
		const deskDir = ctx.options.getDeskDir(desk);
		const document = deskDir ? await readStoredTask(deskDir, id) : undefined;
		if (!deskDir || !document || document.fields.outcome) return { kind: "not_found" };
		const live = ctx.live.get(taskKey(desk, id));
		const text = input.text.trim();

		// Delivered into the step that is running right now, when one is: the record says which
		// step took it, so the next brief does not repeat it (INV-6). The steer comes first — a record
		// of an injection that never happened would hide the message from the next step.
		if (live?.step && live.runner && !live.step.abort) {
			const seq = live.step.seq;
			let injected = false;
			try {
				await live.runner.queueSteer(`[用户对任务 ${id} 说] ${text}`, input.from);
				injected = true;
			} catch (error) {
				log.logInfoEvent("tasks.message.inject_failed", "Message could not join the running step", {
					fields: { taskId: id, desk, reason: errorMessage(error) },
				});
			}
			await appendTaskLog(deskDir, id, {
				kind: "message",
				from: input.from,
				channel: input.channel,
				text,
				...(injected ? { injected: seq } : {}),
			});
			ctx.notify();
			return { kind: injected ? "injected" : "queued_for_next_step" };
		}

		await appendTaskLog(deskDir, id, { kind: "message", from: input.from, channel: input.channel, text });
		ctx.notify();
		if (document.fields.state === "paused") return { kind: "held_paused" };
		if (isFrozen(ctx, desk, document.fields)) return { kind: "held_frozen" };
		return { kind: document.fields.state === "waiting" ? "woke" : "queued_for_next_step" };
	}

	async pause(desk: string, id: string, input: { by: "user"; reason: string }): Promise<TaskControlOutcome> {
		const { ctx } = this;
		const deskDir = ctx.options.getDeskDir(desk);
		if (!deskDir || !(await readStoredTask(deskDir, id))) return { kind: "not_found" };
		const paused = await pauseStoredTask(deskDir, id, { by: input.by, reason: input.reason });
		if (!paused) return { kind: "unchanged" };
		// The step stops; delegations and jobs already in flight keep running and their results are
		// recorded for the step that follows the resume (D24).
		const live = ctx.live.get(taskKey(desk, id));
		if (live) {
			abortStep(live, "pause");
			if (!live.driving) void ctx.release(live);
		}
		ctx.notify();
		return { kind: "ok" };
	}

	async resume(desk: string, id: string, grants: Partial<TaskBudget>): Promise<TaskControlOutcome> {
		const deskDir = this.ctx.options.getDeskDir(desk);
		if (!deskDir || !(await readStoredTask(deskDir, id))) return { kind: "not_found" };
		const resumed = await resumeStoredTask(deskDir, id, grants);
		if (!resumed) return { kind: "unchanged" };
		this.ctx.notify();
		return { kind: "ok" };
	}

	async cancel(
		desk: string,
		id: string,
		input: { by: "user"; note: string; channel?: string },
	): Promise<TaskCancelOutcome> {
		const { ctx } = this;
		const deskDir = ctx.options.getDeskDir(desk);
		const document = deskDir ? await readStoredTask(deskDir, id) : undefined;
		if (!deskDir || !document || document.fields.outcome) return { kind: "not_found" };
		const live = ctx.live.get(taskKey(desk, id));
		if (live) abortStep(live, "cancel");
		const cancelled = await this.cancelBoundWork(desk, id);
		await closeStoredTask(deskDir, id, { outcome: "cancel", by: input.by, note: input.note });
		if (live) await ctx.release(live);
		ctx.notify();
		// A cancel typed in another channel of the desk leaves the report channel told (D29); one typed
		// there is answered by the command's own reply.
		const reportChannel = document.fields.channel;
		if (reportChannel && reportChannel !== input.channel) {
			await ctx.options
				.deliver(desk, reportChannel, cancelledByUserReceipt(id, extractTaskTitle(document.body, id)))
				.catch((error: unknown) =>
					log.logWarn("tasks.task.receipt_failed", "Task cancel receipt failed", {
						channelId: reportChannel,
						reason: errorMessage(error),
						fields: { taskId: id },
					}),
				);
		}
		return { kind: "cancelled", cancelled };
	}

	/** Cancel every delegation and job bound to the task; the refs that were still running. */
	async cancelBoundWork(desk: string, taskId: string): Promise<string[]> {
		const { options } = this.ctx;
		const pending = (await listPendingWork(options, desk, this.ctx.now())).get(taskId) ?? [];
		const cancelled: string[] = [];
		for (const work of pending) {
			try {
				if (work.kind === "delegation") await options.getRuns(desk).cancel(work.ref);
				else await options.getJobs(desk).cancel([work.ref]);
				cancelled.push(work.ref);
			} catch (error) {
				log.logWarn("tasks.task.cancel_work_failed", "Cancelling a task's bound work failed", {
					reason: errorMessage(error),
					fields: { taskId, desk, ref: work.ref },
				});
			}
		}
		return cancelled;
	}
}
