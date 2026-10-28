import { mkdir } from "node:fs/promises";
import { normalizeTaskId, readActiveTasks } from "../../tasks/contract.js";
import type { TaskLiveSnapshot } from "../../tasks/control.js";
import { closeTask as closeStoredTask, readStoredTask } from "../../tasks/store.js";
import { RecoverableToolError } from "../contract/details.js";
import { assertCompletable, requiredField, tasksDir } from "./shared.js";
import type { TaskCloseRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";

export async function requireTask(options: TaskManageToolOptions, id: string) {
	const document = await readStoredTask(options.deskDir, id);
	if (!document) {
		throw new RecoverableToolError(`Task "${id}" does not exist. task_list shows this desk's active tasks.`);
	}
	return document;
}

function describeWaiting(entry: {
	fields: { waiting?: { kind: string; question?: string; until?: string } };
}): string | undefined {
	const waiting = entry.fields.waiting;
	if (!waiting) return undefined;
	if (waiting.kind === "user") return `the user's answer to: ${waiting.question}`;
	if (waiting.kind === "time") return `until ${waiting.until}`;
	return "results of the delegations and jobs in flight";
}

function describeActivity(live: TaskLiveSnapshot | undefined, now: number): string | undefined {
	if (!live?.step) return undefined;
	const minutes = Math.max(0, Math.round((now - live.step.startedAt) / 60_000));
	const tool = live.step.tool ? `; now: ${live.step.tool.summary}` : "";
	return `step ${live.step.seq} running for ${minutes}m, ${live.step.toolsDone} tool calls done${tool}`;
}

function describeInFlight(live: TaskLiveSnapshot | undefined, now: number): string[] | undefined {
	if (!live || live.pending.length === 0) return undefined;
	return live.pending.map((work) => {
		const running = Math.max(0, Math.round((now - work.startedAt) / 60_000));
		const quiet =
			work.lastOutputAt !== undefined
				? `, last output ${Math.max(0, Math.round((now - work.lastOutputAt) / 60_000))}m ago`
				: "";
		return `${work.ref} (${work.label}) running ${running}m${quiet}${work.stalled ? " — looks stalled" : ""}`;
	});
}

/** `task_list`: every active task of the desk, with what each is doing right now and what it waits for. */
export async function listTasks(options: TaskManageToolOptions): Promise<TaskManageResult> {
	const dir = tasksDir(options);
	await mkdir(dir, { recursive: true });
	const entries = (await readActiveTasks(dir)).filter((entry) => !entry.fields.outcome);
	const snapshots = new Map(
		((await options.control?.snapshot(options.desk).catch(() => [])) ?? []).map((snapshot) => [
			snapshot.id,
			snapshot,
		]),
	);
	const now = Date.now();
	const tasks = entries.map((entry) => {
		const live = snapshots.get(entry.id);
		return {
			id: entry.id,
			title: entry.title,
			state: entry.readable ? entry.fields.state : "unreadable",
			waiting: describeWaiting(entry),
			frozen: live?.frozen,
			channel: entry.fields.channel,
			deliversHere: entry.fields.channel === options.channelId,
			steps: entry.fields.usage?.steps,
			usd: entry.fields.usage ? Number(entry.fields.usage.usd.toFixed(2)) : undefined,
			items: entry.items ? `${entry.items.done}/${entry.items.total}` : undefined,
			activity: describeActivity(live, now),
			inFlight: describeInFlight(live, now),
		};
	});
	return {
		action: "list",
		tasks,
		notice: tasks.length === 0 ? "暂无进行中的任务。" : `共 ${tasks.length} 个进行中的任务。`,
	};
}

/**
 * `task_close` from a chat: `complete` archives a task nothing is working on, `cancel` stops the
 * running step and everything bound to it through the lane (spec 064, D23).
 */
export async function closeTaskFromChat(
	options: TaskManageToolOptions,
	request: TaskCloseRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const note = requiredField(request.note, "note", `task_close outcome=${request.outcome}`);
	const document = await requireTask(options, id);

	if (request.outcome === "cancel") {
		if (!options.control) {
			throw new RecoverableToolError("Cancelling a task needs the task lane, which this session does not have.");
		}
		const outcome = await options.control.cancel(options.desk, id, { by: "user", note, channel: options.channelId });
		if (outcome.kind === "not_found") throw new RecoverableToolError(`Task "${id}" no longer exists.`);
		const stopped =
			outcome.cancelled.length > 0 ? ` 同时取消了在途的委派/作业：${outcome.cancelled.join(", ")}。` : "";
		return {
			action: "close",
			id,
			archived: true,
			cancelled: outcome.cancelled,
			notice: `任务 \`${id}\` 已取消并归档。${stopped}`,
		};
	}

	if (document.fields.state === "running") {
		throw new RecoverableToolError(
			`Task "${id}" is executing a step right now. Tell it with task_message to finish up, or pause it with task_pause first; the leader completes its own task.`,
		);
	}
	await assertCompletable(options, document, id);
	await closeStoredTask(options.deskDir, id, { outcome: "complete", by: "user", note });
	return { action: "close", id, archived: true, notice: `任务 \`${id}\` 已完成并归档。` };
}
