import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeTaskId } from "../tasks/ledger.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { createTask } from "./task-manage/create.js";
import { closeTask, listTasks, updateTask } from "./task-manage/lifecycle.js";
import {
	taskCloseSchema,
	taskCreateSchema,
	taskListSchema,
	taskUpdateSchema,
	taskVerifySchema,
} from "./task-manage/schema.js";
import type {
	TaskCloseRequest,
	TaskCreateRequest,
	TaskManageToolOptions,
	TaskUpdateRequest,
	TaskVerifyRequest,
} from "./task-manage/types.js";
import { verifyTask } from "./task-manage/verification.js";

export type {
	TaskCloseRequest,
	TaskCreateRequest,
	TaskManageResult,
	TaskManageToolOptions,
	TaskUpdateRequest,
	TaskVerifyRequest,
} from "./task-manage/types.js";

/**
 * Five tools, one per payload shape (spec 046, D3.1) — replaces the single `task_manage`
 * dispatcher. Each factory only wires its own schema and, for the four that carry an `id`, the
 * same per-task serial lock `manageTask` used to apply centrally (spec 029, D7): a task file
 * write must never race another write to the same task, and that guarantee has to travel with
 * the split, not get silently dropped in the split (spec 046, D3.4).
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
		description: "Create a persistent task: goal, DoD, and optional plan, manual, verification plan, and schedule.",
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
			"With `note`: checkpoint an open task cycle. Without: metadata-only edit (status/wake/schedule/planSteps/control), also the only path that repairs a bad control line.",
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

export function createTaskVerifyTool(options: TaskManageToolOptions): AgentTool<typeof taskVerifySchema> {
	return {
		name: "task_verify",
		label: "task_verify",
		description: "Import a purpose=verify sub-agent's attestation by run id.",
		parameters: taskVerifySchema,
		execute: async (_toolCallId, args: TaskVerifyRequest) => {
			const result = await withLock(options, args.id, () => verifyTask(options, args));
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: { ...result } };
		},
	};
}
