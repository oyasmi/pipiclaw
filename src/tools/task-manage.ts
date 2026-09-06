import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeTaskId } from "../tasks/ledger.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { createTask } from "./task-manage/create.js";
import { closeTask, listTasks, updateTask } from "./task-manage/lifecycle.js";
import { readTaskLogTool } from "./task-manage/log-view.js";
import {
	taskCloseSchema,
	taskCreateSchema,
	taskListSchema,
	taskLogSchema,
	taskStepEndSchema,
	taskUpdateSchema,
} from "./task-manage/schema.js";
import { endTaskStep } from "./task-manage/step-end.js";
import type {
	TaskCloseRequest,
	TaskCreateRequest,
	TaskLogRequest,
	TaskManageToolOptions,
	TaskStepEndRequest,
	TaskUpdateRequest,
} from "./task-manage/types.js";

export type {
	TaskCloseRequest,
	TaskCreateRequest,
	TaskLogRequest,
	TaskManageResult,
	TaskManageToolOptions,
	TaskStepEndRequest,
	TaskUpdateRequest,
} from "./task-manage/types.js";

/**
 * One tool per payload shape (spec 046, D3.1). Each factory wires only its own schema and, for
 * the ones that carry an `id`, the same per-task serial lock (spec 029, D7): a task file write
 * must never race another write to the same task, and that guarantee travels with the split.
 *
 * Spec 051 retired `task_verify` — importing a verifier's attestation is bookkeeping the runtime
 * does at settlement, not a decision worth a tool call — and added `task_log` (read the loop log)
 * and `task_step_end` (the loop's only closing move, registered only inside a task session).
 */

async function withLock<T>(options: TaskManageToolOptions, id: string, mutate: () => Promise<T>): Promise<T> {
	return withTaskMutation(options.channelDir, normalizeTaskId(id), mutate);
}

export function createTaskListTool(options: TaskManageToolOptions): AgentTool<typeof taskListSchema> {
	return {
		name: "task_list",
		label: "task_list",
		description: "List persistent tasks in this channel's active directory.",
		parameters: taskListSchema,
		execute: async () => {
			const result = await listTasks(options);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
		},
	};
}

export function createTaskCreateTool(options: TaskManageToolOptions): AgentTool<typeof taskCreateSchema> {
	return {
		name: "task_create",
		label: "task_create",
		description:
			"Create a persistent task: goal, DoD, and optional plan, manual, verification plan, schedule, budget.",
		parameters: taskCreateSchema,
		execute: async (_toolCallId, args: TaskCreateRequest) => {
			const result = await withLock(options, args.id, () => createTask(options, args));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
		},
	};
}

export function createTaskUpdateTool(options: TaskManageToolOptions): AgentTool<typeof taskUpdateSchema> {
	return {
		name: "task_update",
		label: "task_update",
		description:
			"Edit a task's plan steps, cadence, budget, or verification requirement. Progress goes to task_step_end.",
		parameters: taskUpdateSchema,
		execute: async (_toolCallId, args: TaskUpdateRequest) => {
			const result = await withLock(options, args.id, () => updateTask(options, args));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
		},
	};
}

export function createTaskCloseTool(options: TaskManageToolOptions): AgentTool<typeof taskCloseSchema> {
	return {
		name: "task_close",
		label: "task_close",
		description: "Close a task: outcome complete, skip (one recurring occurrence), or cancel.",
		parameters: taskCloseSchema,
		execute: async (_toolCallId, args: TaskCloseRequest) => {
			const result = await withLock(options, args.id, () => closeTask(options, args));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
		},
	};
}

export function createTaskLogTool(options: TaskManageToolOptions): AgentTool<typeof taskLogSchema> {
	return {
		name: "task_log",
		label: "task_log",
		description: "Read a task's loop log: steps, verification rounds, expiries and cycle closes.",
		parameters: taskLogSchema,
		execute: async (_toolCallId, args: TaskLogRequest) => {
			const result = await readTaskLogTool(options, args);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
		},
	};
}

export function createTaskStepEndTool(options: TaskManageToolOptions): AgentTool<typeof taskStepEndSchema> {
	return {
		name: "task_step_end",
		label: "task_step_end",
		description:
			"End this task step: continue (more work now), park (wait on a ticket), done (close the cycle), or blocked (ask the user).",
		parameters: taskStepEndSchema,
		execute: async (_toolCallId, args: TaskStepEndRequest) => {
			const result = await withLock(options, options.taskId ?? "", () => endTaskStep(options, args));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
		},
	};
}
