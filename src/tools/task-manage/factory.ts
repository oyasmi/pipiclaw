/**
 * The task tool factories. Two surfaces (spec 064, D21):
 * chat — `task_list`, `task_create`, `task_log`, `task_close`, `task_message`, `task_pause`,
 * `task_resume`; task session — `task_log`, `task_close`, `task_report`, `task_ask`, `task_wait`.
 * Each factory wires only its own schema and the per-task serial lock where it writes a task file.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeTaskId } from "../../tasks/contract.js";
import { withTaskMutation } from "../../tasks/mutation-lock.js";
import { messageTask, pauseTask, resumeTask } from "./control-tools.js";
import { createTask } from "./create.js";
import { closeTaskFromChat, listTasks } from "./lifecycle.js";
import { readTaskLogTool } from "./log-view.js";
import {
	taskAskSchema,
	taskCloseSchema,
	taskCreateSchema,
	taskListSchema,
	taskLogSchema,
	taskMessageSchema,
	taskPauseSchema,
	taskReportSchema,
	taskResumeSchema,
	taskWaitSchema,
} from "./schema.js";
import { askUser, closeTaskInSession, reportToUser, waitUntil } from "./step-tools.js";
import type {
	TaskAskRequest,
	TaskCloseRequest,
	TaskCreateRequest,
	TaskListRequest,
	TaskListToolOptions,
	TaskLogRequest,
	TaskManageResult,
	TaskManageToolOptions,
	TaskMessageRequest,
	TaskPauseRequest,
	TaskReportRequest,
	TaskResumeRequest,
	TaskWaitRequest,
} from "./types.js";

export type { TaskManageResult, TaskManageToolOptions } from "./types.js";

function formatTaskResultText(result: TaskManageResult): string {
	const lines = [result.notice];
	if (result.action === "log") lines.push(...(result.entries ?? []));
	if (result.action === "list") {
		for (const task of result.tasks ?? []) {
			const state = task.state + (task.archived ? " (archived)" : "") + (task.frozen ? " (frozen)" : "");
			const fields = [
				task.steps !== undefined && `steps=${task.steps}`,
				task.usd !== undefined && `usd=${task.usd}`,
				Boolean(task.unknownCostCount) && `unknown costs=${task.unknownCostCount}`,
				task.items && `items=${task.items}`,
				task.closedAt && `closed=${task.closedAt}`,
				task.waiting && `waiting for ${task.waiting}`,
				task.activity,
				task.inFlight?.join("; "),
				!task.deliversHere && `delivers to ${task.channel ?? "another channel"}`,
			].filter(Boolean);
			lines.push(`- [${task.id}] ${state} — ${task.title}${fields.length ? ` (${fields.join(" · ")})` : ""}`);
		}
	}
	const fields = [
		result.id && `id=${result.id}`,
		result.path && `path=${result.path}`,
		result.state && `state=${result.state}`,
		result.archived !== undefined && `archived=${result.archived}`,
		result.cancelled?.length && `cancelled=${result.cancelled.join(", ")}`,
	].filter(Boolean);
	if (fields.length) lines.push(fields.join(" · "));
	return lines.join("\n");
}

function asResult(result: TaskManageResult, terminate = false) {
	return {
		content: [{ type: "text" as const, text: formatTaskResultText(result) }],
		details: { ...result },
		terminate,
	};
}

/**
 * One tool per payload shape (spec 046, D3.1). The ones that carry an `id` take the same per-task
 * serial lock (spec 029, D7): a task file write must never race another write to the same task.
 */
async function withLock<T>(options: TaskManageToolOptions, id: string, mutate: () => Promise<T>): Promise<T> {
	return withTaskMutation(options.deskDir, normalizeTaskId(id), mutate);
}

export function createTaskListTool(options: TaskListToolOptions): AgentTool<typeof taskListSchema> {
	return {
		name: "task_list",
		label: "task_list",
		description:
			"Get live task progress for this desk: state, waiting source, current step and in-flight delegations. Marks reports delivered to other channels. Use task_log for history.",
		parameters: taskListSchema,
		execute: async (_toolCallId, args: TaskListRequest) => asResult(await listTasks(options, args)),
	};
}

export function createTaskCreateTool(options: TaskManageToolOptions): AgentTool<typeof taskCreateSchema> {
	return {
		name: "task_create",
		label: "task_create",
		description:
			"Create a persistent project you lead in its own background session alongside this chat. Read task-manage.md for scope, contract and management workflows.",
		parameters: taskCreateSchema,
		execute: async (_toolCallId, args: TaskCreateRequest) =>
			asResult(await withLock(options, args.id, () => createTask(options, args))),
	};
}

export function createTaskCloseTool(options: TaskManageToolOptions): AgentTool<typeof taskCloseSchema> {
	return {
		name: "task_close",
		label: "task_close",
		description: options.session
			? "Complete after checked DoD, closed Work Items, no in-flight work and this step's task_report; delivery retries before archive. Cancel stops task work."
			: "Complete an idle task with checked DoD, closed Work Items and the last step's delivered report; otherwise ask its leader to finish. Cancel stops task work.",
		parameters: taskCloseSchema,
		execute: async (_toolCallId, args: TaskCloseRequest) => {
			if (options.session) return asResult(await closeTaskInSession(options, args), true);
			return asResult(await closeTaskFromChat(options, args));
		},
	};
}

export function createTaskLogTool(options: TaskManageToolOptions): AgentTool<typeof taskLogSchema> {
	return {
		name: "task_log",
		label: "task_log",
		description:
			"Read a task's log: steps and what each did, dispatches, settlements, stall reports, user messages, reports, pauses and the close.",
		parameters: taskLogSchema,
		execute: async (_toolCallId, args: TaskLogRequest) => asResult(await readTaskLogTool(options, args)),
	};
}

export function createTaskMessageTool(options: TaskManageToolOptions): AgentTool<typeof taskMessageSchema> {
	return {
		name: "task_message",
		label: "task_message",
		description:
			"Pass the user's words to a task: new requirements, a correction, or the answer to a question the task asked. A running step receives it at once; otherwise the next step starts with it. Relay verbatim; do not do the task's work yourself.",
		parameters: taskMessageSchema,
		execute: async (_toolCallId, args: TaskMessageRequest) => asResult(await messageTask(options, args)),
	};
}

export function createTaskPauseTool(options: TaskManageToolOptions): AgentTool<typeof taskPauseSchema> {
	return {
		name: "task_pause",
		label: "task_pause",
		description:
			"Pause a task: its running step is stopped, delegations and jobs already in flight keep running and their results are recorded. Resume it with task_resume.",
		parameters: taskPauseSchema,
		execute: async (_toolCallId, args: TaskPauseRequest) => asResult(await pauseTask(options, args)),
	};
}

export function createTaskResumeTool(options: TaskManageToolOptions): AgentTool<typeof taskResumeSchema> {
	return {
		name: "task_resume",
		label: "task_resume",
		description:
			"Resume a paused task. `steps` / `usd` add budget on top of what the task already used — needed when it was paused for running out.",
		parameters: taskResumeSchema,
		execute: async (_toolCallId, args: TaskResumeRequest) => asResult(await resumeTask(options, args)),
	};
}

export function createTaskReportTool(options: TaskManageToolOptions): AgentTool<typeof taskReportSchema> {
	return {
		name: "task_report",
		label: "task_report",
		description:
			"Report a deliverable, important progress or a risk to the user; at most 3 per step. Ordinary step replies stay in the task log; use task_ask for a question that needs the user's answer.",
		parameters: taskReportSchema,
		execute: async (_toolCallId, args: TaskReportRequest) => asResult(await reportToUser(options, args)),
	};
}

export function createTaskAskTool(options: TaskManageToolOptions): AgentTool<typeof taskAskSchema> {
	return {
		name: "task_ask",
		label: "task_ask",
		description:
			"Ask the user a question and wait for the answer, however long it takes. Ends the step; the next step starts when the user replies.",
		parameters: taskAskSchema,
		execute: async (_toolCallId, args: TaskAskRequest) => asResult(await askUser(options, args), true),
	};
}

export function createTaskWaitTool(options: TaskManageToolOptions): AgentTool<typeof taskWaitSchema> {
	return {
		name: "task_wait",
		label: "task_wait",
		description:
			'Wait until a moment ("+30m", "+2h", "+1d" or a local time, 1 minute to 30 days ahead). Ends the step; new results or user messages wake the task earlier.',
		parameters: taskWaitSchema,
		execute: async (_toolCallId, args: TaskWaitRequest) => asResult(await waitUntil(options, args), true),
	};
}
