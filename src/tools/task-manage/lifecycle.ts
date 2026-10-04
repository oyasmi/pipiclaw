import { mkdir } from "node:fs/promises";
import { normalizeTaskBudget } from "../../tasks/contract-input.js";
import { applyTaskItemsPatch, normalizeTaskId, readActiveTasks } from "../../tasks/ledger.js";
import { readStoredTask, writeStoredTask } from "../../tasks/store.js";
import { describeTicket } from "../../tasks/ticket.js";
import { RecoverableToolError } from "../tool-details.js";
import { closeTaskDocument, describeTaskState, requiredField, tasksDir } from "./shared.js";
import type { TaskCloseRequest, TaskManageResult, TaskManageToolOptions, TaskUpdateRequest } from "./types.js";

async function requireTask(options: TaskManageToolOptions, id: string) {
	const document = await readStoredTask(options.channelDir, id);
	if (!document) {
		throw new RecoverableToolError(`Task "${id}" does not exist; create it with task_create first.`);
	}
	return document;
}

/**
 * `task_update` is metadata only (spec 051, D4): Work Items and budget. Progress notes are not
 * written here — they belong to the loop log via `task_step_end`, which is the only writer that
 * can also change what the task is waiting for. Keeping the two apart is what stops "checkpoint"
 * from quietly becoming a state transition.
 */
export async function updateTask(
	options: TaskManageToolOptions,
	request: TaskUpdateRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const document = await requireTask(options, id);

	const changes: string[] = [];
	if (request.items?.length) {
		const patched = applyTaskItemsPatch(document.body, request.items);
		document.body = patched.body;
		if (patched.summary) changes.push(patched.summary);
	}
	const budget = normalizeTaskBudget(request.budget);
	if (budget) {
		document.fields.budget = { ...document.fields.budget, ...budget };
		changes.push("budget 已更新");
	}
	await writeStoredTask(document);
	return {
		action: "update",
		id,
		path: document.path,
		state: document.fields.state,
		notice: `任务 \`${id}\` 已更新（${changes.length > 0 ? changes.join("；") : "无字段变化"}）。${describeTaskState(document.fields)}`,
	};
}

/**
 * Close a task from the chat surface: `complete` archives it, `cancel` archives it as abandoned.
 * The loop's own `task_step_end outcome=done` shares the same close-out path.
 */
export async function closeTask(options: TaskManageToolOptions, request: TaskCloseRequest): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const document = await requireTask(options, id);
	const note = requiredField(request.note, "note", `task_close outcome=${request.outcome}`);
	const { stillRunning } = await closeTaskDocument({ options, document, id, outcome: request.outcome, note });
	const running =
		stillRunning.length > 0
			? ` 仍在运行的委派/作业不会被取消：${stillRunning.join(", ")}（用 subagent_run op=cancel / job cancel 处理）。`
			: "";
	return {
		action: "close",
		id,
		archived: true,
		notice: `任务 \`${id}\` 已${request.outcome === "complete" ? "完成" : "取消"}并归档。${running}`,
	};
}

export async function listTasks(options: TaskManageToolOptions): Promise<TaskManageResult> {
	const dir = tasksDir(options);
	await mkdir(dir, { recursive: true });
	const entries = await readActiveTasks(dir);
	const tasks = entries.map((entry) => ({
		id: entry.id,
		title: entry.title,
		state: entry.fields.state,
		paused: Boolean(entry.fields.paused),
		ticket: entry.fields.ticket ? describeTicket(entry.fields.ticket) : undefined,
		steps: entry.fields.usage?.steps,
		items: entry.items ? `${entry.items.done}/${entry.items.total}` : undefined,
	}));
	return {
		action: "list",
		tasks,
		notice: tasks.length === 0 ? "暂无进行中的任务。" : `共 ${tasks.length} 个进行中的任务。`,
	};
}
