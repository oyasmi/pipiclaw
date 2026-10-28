import { normalizeTaskId } from "../../tasks/contract.js";
import type { TaskControl } from "../../tasks/control.js";
import { RecoverableToolError } from "../contract/details.js";
import { requiredField } from "./shared.js";
import type {
	TaskManageResult,
	TaskManageToolOptions,
	TaskMessageRequest,
	TaskPauseRequest,
	TaskResumeRequest,
} from "./types.js";

/** The chat side of managing a task: say something to it, stop it, let it go on (spec 064, D23). */

function control(options: TaskManageToolOptions): TaskControl {
	if (!options.control) {
		throw new RecoverableToolError(
			"The task lane is not available in this session, so tasks cannot be managed from it.",
		);
	}
	return options.control;
}

function notFound(id: string): RecoverableToolError {
	return new RecoverableToolError(`Task "${id}" does not exist. task_list shows this desk's active tasks.`);
}

const MESSAGE_NOTICES = {
	injected: "已送进任务正在执行的这一步。",
	queued_for_next_step: "已记下，任务的下一步会看到。",
	woke: "已记下，任务被叫醒并会继续推进。",
	held_paused: "任务已暂停：已记下，恢复后下一步会看到。",
	held_frozen: "任务的汇报频道未绑定到本工位，任务已冻结：已记下，频道绑定回来后下一步会看到。",
} as const;

export async function messageTask(
	options: TaskManageToolOptions,
	request: TaskMessageRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const text = requiredField(request.text, "text", "task_message");
	const outcome = await control(options).message(options.desk, id, {
		from: "chat",
		channel: options.channelId,
		text,
	});
	if (outcome.kind === "not_found") throw notFound(id);
	return { action: "message", id, notice: `任务 \`${id}\`：${MESSAGE_NOTICES[outcome.kind]}` };
}

export async function pauseTask(options: TaskManageToolOptions, request: TaskPauseRequest): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const reason = requiredField(request.reason, "reason", "task_pause");
	const outcome = await control(options).pause(options.desk, id, { by: "user", reason });
	if (outcome.kind === "not_found") throw notFound(id);
	return {
		action: "pause",
		id,
		notice:
			outcome.kind === "unchanged"
				? `任务 \`${id}\` 已经是暂停状态。`
				: `任务 \`${id}\` 已暂停：当前步骤已中止，在途的委派和作业继续运行，结果会记下。`,
	};
}

export async function resumeTask(
	options: TaskManageToolOptions,
	request: TaskResumeRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const outcome = await control(options).resume(options.desk, id, {
		...(request.steps ? { steps: request.steps } : {}),
		...(request.usd ? { usd: request.usd } : {}),
	});
	if (outcome.kind === "not_found") throw notFound(id);
	return {
		action: "resume",
		id,
		notice:
			outcome.kind === "unchanged"
				? `任务 \`${id}\` 当前没有暂停，无需恢复。`
				: `任务 \`${id}\` 已恢复，排队等待执行。`,
	};
}
