import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TaskControlPatch } from "../tasks/control.js";
import { createTask } from "./task-manage/create.js";
import { cancelTask, doneTask, listTasks, progressTask, setTask, skipTask } from "./task-manage/lifecycle.js";
import { parseAction, taskManageSchema } from "./task-manage/schema.js";
import type { TaskManageRequest, TaskManageResult, TaskManageToolOptions } from "./task-manage/types.js";
import { candidateTask, verifyTask } from "./task-manage/verification.js";

export type {
	TaskManageAction,
	TaskManageRequest,
	TaskManageResult,
	TaskManageToolOptions,
} from "./task-manage/types.js";

/**
 * The `task_manage` dispatcher. Each action lives in a focused module — `create`,
 * `lifecycle` (progress/set/done/cancel/list) and `verification` (candidate/verify) — over a
 * shared helper layer, with the status transition table in `src/tasks/transitions.ts` (spec
 * 029, D7). This entry only routes and wraps the tool.
 */
export async function manageTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	switch (request.action) {
		case "create":
			return createTask(options, request);
		case "progress":
			return progressTask(options, request);
		case "candidate":
			return candidateTask(options, request);
		case "set":
			return setTask(options, request);
		case "verify":
			return verifyTask(options, request);
		case "done":
			return doneTask(options, request);
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
			"Manage governed persistent tasks: create, atomically checkpoint progress/control state, import an independent " +
			"verifier attestation, complete verified work, skip one recurring occurrence, cancel abandoned work, or list tasks. Use progress for routine " +
			"end-of-turn checkpoints; use write/edit only for substantial Goal/DoD/Manual/Verification changes.",
		parameters: taskManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				label: string;
				action: string;
				id?: string;
				title?: string;
				goal?: string;
				dod?: string;
				manual?: string;
				verificationPlan?: string;
				control?: TaskControlPatch;
				status?: string;
				wake?: string;
				schedule?: string;
				recurrence?: string;
				note?: string;
				verifierRunId?: string;
				summary?: string;
				evidence?: string;
				residualRisk?: string;
				reason?: string;
			},
		) => {
			const result = await manageTask(options, {
				action: parseAction(args.action),
				id: args.id,
				title: args.title,
				goal: args.goal,
				dod: args.dod,
				manual: args.manual,
				verificationPlan: args.verificationPlan,
				control: args.control,
				status: args.status,
				wake: args.wake,
				schedule: args.schedule,
				recurrence: args.recurrence,
				note: args.note,
				verifierRunId: args.verifierRunId,
				summary: args.summary,
				evidence: args.evidence,
				residualRisk: args.residualRisk,
				reason: args.reason,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: {
					kind: "task_manage",
					...result,
				},
			};
		},
	};
}
