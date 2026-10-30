import * as log from "../log.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";
import { isTaskArchiving } from "../tasks/archive.js";
import { taskReportDelivered } from "../tasks/completion.js";
import type { TaskStepIntent } from "../tasks/control.js";
import { drainTaskDeliveries } from "../tasks/delivery.js";
import { appendTaskLog, readTaskLog } from "../tasks/loop-log.js";
import { cancelledByLeaderReceipt, completedReceipt } from "../tasks/receipts.js";
import { closeTask, pauseTask } from "../tasks/store.js";
import type { LaneContext, LiveTask } from "./task-lane-types.js";
import { listPendingWork } from "./task-pending.js";

/** Commit the leader's durable close without another model turn. Delivery failures retain that intent. */
export async function finishTaskClose(
	ctx: LaneContext,
	live: LiveTask,
	title: string,
	intent: TaskStepIntent,
	cancelWork: (desk: string, id: string) => Promise<string[]>,
	dispose: (live: LiveTask) => Promise<void>,
): Promise<number | undefined> {
	let next: number | undefined;
	const noteHorizon = (at: number | undefined) => {
		if (at !== undefined) next = Math.min(next ?? at, at);
	};
	const flush = async (desk: string, deskDir: string) => {
		try {
			noteHorizon(
				await drainTaskDeliveries(
					deskDir,
					(channel, text) => ctx.options.deliver(desk, channel, text),
					(channel) => ctx.options.isBoundTo(channel, desk) && ctx.options.isReachable(channel),
					ctx.now(),
				),
			);
		} catch (error) {
			log.logWarn("tasks.delivery.drain_failed", "Task delivery drain failed", {
				reason: errorMessage(error),
				fields: { desk },
			});
			noteHorizon(ctx.now() + 60_000);
		}
	};
	const say = async (target: LiveTask, text: string) => {
		try {
			await ctx.options.deliver(target.desk, target.channelId, text);
		} catch (error) {
			log.logWarn("tasks.task.receipt_failed", "Task receipt delivery failed", {
				reason: errorMessage(error),
				channelId: target.channelId,
			});
		}
	};
	const close = intent.close;
	if (!close) return next;
	try {
		if (close.outcome === "complete") {
			if (!close.reportId)
				throw new RecoverableToolError(
					"The close intent has no final report. Deliver a final task_report before completing.",
				);
			await flush(live.desk, live.deskDir);
			if (!taskReportDelivered(await readTaskLog(live.deskDir, live.taskId, { strict: true }), close.reportId)) {
				await dispose(live);
				return next;
			}
			const pending = (await listPendingWork(ctx.options, live.desk, ctx.now())).get(live.taskId) ?? [];
			if (pending.length > 0)
				throw new RecoverableToolError("Task still has work in flight; stop that work before retrying completion.");
		}
		if (close.outcome === "cancel") await cancelWork(live.desk, live.taskId);
		const closed = await closeTask(live.deskDir, live.taskId, {
			outcome: close.outcome,
			by: "leader",
			note: close.note,
			reportId: close.reportId,
			receipt: (document, closedAt) =>
				close.outcome === "complete"
					? completedReceipt(live.taskId, title, document, closedAt)
					: cancelledByLeaderReceipt(live.taskId, title, close.note),
		});
		if (!closed) {
			await dispose(live);
			return next;
		}
	} catch (error) {
		log.logWarn("tasks.task.close_failed", "Closing a task failed", {
			channelId: live.channelId,
			reason: errorMessage(error),
			fields: { taskId: live.taskId, desk: live.desk },
		});
		if (isTaskArchiving(live.deskDir, live.taskId)) {
			noteHorizon(ctx.now() + 60_000);
			await dispose(live);
			return next;
		}
		if (
			error instanceof RecoverableToolError &&
			!(await readTaskLog(live.deskDir, live.taskId)).some((record) => record.kind === "close")
		) {
			await appendTaskLog(live.deskDir, live.taskId, { kind: "close_rejected", reason: errorMessage(error) });
			await dispose(live);
			ctx.notify();
			return next;
		}
		await pauseTask(live.deskDir, live.taskId, {
			by: "runtime",
			reason: "任务归档或取消未完成，请联系部署者检查服务器后重试关闭",
		});
		await dispose(live);
		await say(live, `⚠️ 任务 \`${live.taskId}\` 未能关闭，已暂停。请联系部署者检查服务器，再发送消息重试关闭。`);
		return next;
	}
	await dispose(live);
	await flush(live.desk, live.deskDir);
	return next;
}
