import type { AgentTool } from "@earendil-works/pi-agent-core";
import { normalizeTaskId } from "../tasks/ledger.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { createTask } from "./task-manage/create.js";
import { cancelTask, completeTask, listTasks, progressTask, setTask, skipTask } from "./task-manage/lifecycle.js";
import { parseAction, taskManageSchema } from "./task-manage/schema.js";
import type { TaskManageRequest, TaskManageResult, TaskManageToolOptions } from "./task-manage/types.js";
import { requestVerificationTask, verifyTask } from "./task-manage/verification.js";

export type {
	TaskManageAction,
	TaskManageRequest,
	TaskManageResult,
	TaskManageToolOptions,
} from "./task-manage/types.js";

/**
 * The `task_manage` dispatcher. Each action lives in a focused module — `create`,
 * `lifecycle` (progress/set/complete/skip/cancel/list) and `verification` (request-verification/verify) — over a
 * shared helper layer, with the status transition table in `src/tasks/transitions.ts` (spec
 * 029, D7). This entry only routes and wraps the tool.
 */
export async function manageTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	if (request.action === "list") return listTasks(options);
	if (!request.id) return dispatchTaskMutation(options, request);
	const id = normalizeTaskId(request.id);
	return withTaskMutation(options.channelDir, id, () => dispatchTaskMutation(options, request));
}

function dispatchTaskMutation(
	options: TaskManageToolOptions,
	request: Exclude<TaskManageRequest, { action: "list" }> | TaskManageRequest,
): Promise<TaskManageResult> {
	switch (request.action) {
		case "create":
			return createTask(options, request);
		case "progress":
			return progressTask(options, request);
		case "request-verification":
			return requestVerificationTask(options, request);
		case "set":
			return setTask(options, request);
		case "verify":
			return verifyTask(options, request);
		case "complete":
			return completeTask(options, request);
		case "skip":
			return skipTask(options, request);
		case "cancel":
			return cancelTask(options, request);
		case "list":
			return listTasks(options);
	}
}

export function createTaskManageTool(options: TaskManageToolOptions): AgentTool<typeof taskManageSchema> {
	return {
		name: "task_manage",
		label: "task_manage",
		description:
			"Manage persistent tasks: create, atomically checkpoint progress/control state, request/import independent " +
			"verification, complete work, skip one recurring occurrence, cancel abandoned work, or list tasks. Use progress for routine " +
			"end-of-turn checkpoints; use write/edit only for substantial Goal/DoD/Manual/Verification changes.",
		parameters: taskManageSchema,
		// `args` is typed from `taskManageSchema`, and so is `TaskManageRequest`: the request is
		// the validated arguments minus `label`, with no third hand-written copy to drift.
		execute: async (_toolCallId, args) => {
			const { label: _label, ...request } = args;
			const result = await manageTask(options, {
				...request,
				action: parseAction(request.action),
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: { ...result },
			};
		},
	};
}
