import { normalizeTaskId } from "../../tasks/contract.js";
import { MAX_REPORTS_PER_STEP, type TaskSessionContext } from "../../tasks/control.js";
import { appendTaskLog } from "../../tasks/loop-log.js";
import { parseWaitUntil } from "../../tasks/state.js";
import { RecoverableToolError } from "../contract/details.js";
import { requireTask } from "./lifecycle.js";
import { assertCompletable, requiredField } from "./shared.js";
import type {
	TaskAskRequest,
	TaskCloseRequest,
	TaskManageResult,
	TaskManageToolOptions,
	TaskReportRequest,
	TaskWaitRequest,
} from "./types.js";

/**
 * The tools of a task session (spec 064, D22). They validate, write log records and register the
 * step's *intent*; they never write state — the lane derives the next state from the intent and the
 * facts when the step ends (INV-2). `task_ask`, `task_wait` and `task_close` end the step.
 */

function session(options: TaskManageToolOptions): TaskSessionContext {
	if (!options.session) throw new RecoverableToolError("This tool is only available inside a task step.");
	return options.session;
}

/** Name the intent already registered this step, so the model sees why the new one is refused. */
function registeredIntent(ctx: TaskSessionContext): string | undefined {
	const intent = ctx.intent();
	if (intent.close) return `task_close (${intent.close.outcome})`;
	if (intent.ask) return "task_ask";
	if (intent.waitUntil) return "task_wait";
	return undefined;
}

function assertNoIntent(ctx: TaskSessionContext, wanted: string): void {
	const registered = registeredIntent(ctx);
	if (registered) {
		throw new RecoverableToolError(
			`This step already registered ${registered}; ${wanted} cannot be added. End the step now.`,
		);
	}
}

export async function closeTaskInSession(
	options: TaskManageToolOptions,
	request: TaskCloseRequest,
): Promise<TaskManageResult> {
	const ctx = session(options);
	const id = normalizeTaskId(request.id);
	if (id !== ctx.taskId) {
		throw new RecoverableToolError(`This is task ${ctx.taskId}'s session — close only this task.`);
	}
	const note = requiredField(request.note, "note", `task_close outcome=${request.outcome}`);
	assertNoIntent(ctx, "task_close");
	if (request.outcome === "complete") await assertCompletable(options, await requireTask(options, id), id);
	// The close itself happens when the step ends: the lane records the step first so the archived
	// log is whole, and a cancel also cancels what this task still has in flight.
	ctx.intent().close = { outcome: request.outcome, note };
	return {
		action: "close",
		id,
		notice:
			request.outcome === "complete"
				? `任务 \`${id}\` 将在本步结束时完成并归档。`
				: `任务 \`${id}\` 将在本步结束时取消并归档，在途的委派和作业会一并取消。`,
	};
}

export async function reportToUser(
	options: TaskManageToolOptions,
	request: TaskReportRequest,
): Promise<TaskManageResult> {
	const ctx = session(options);
	const text = requiredField(request.text, "text", "task_report");
	const intent = ctx.intent();
	if (intent.reports >= MAX_REPORTS_PER_STEP) {
		throw new RecoverableToolError(
			`This step already sent ${MAX_REPORTS_PER_STEP} reports. Put the rest in one final report, or end the step.`,
		);
	}
	intent.reports++;
	const delivered = await ctx.report(text);
	await appendTaskLog(options.deskDir, ctx.taskId, { kind: "report", seq: ctx.seq(), text, delivered });
	return {
		action: "report",
		id: ctx.taskId,
		notice: delivered
			? "已发送给用户。"
			: "没有送达用户（汇报频道暂时不可用）；内容已记入任务记录，需要时在下一步用 task_ask 或再次 task_report。",
	};
}

export async function askUser(options: TaskManageToolOptions, request: TaskAskRequest): Promise<TaskManageResult> {
	const ctx = session(options);
	const question = requiredField(request.question, "question", "task_ask");
	if (question.length > 500) {
		throw new RecoverableToolError(
			"task_ask question is longer than 500 characters. Shorten it to one answerable question.",
		);
	}
	assertNoIntent(ctx, "task_ask");
	ctx.intent().ask = { question };
	await appendTaskLog(options.deskDir, ctx.taskId, { kind: "ask", seq: ctx.seq(), question });
	return {
		action: "ask",
		id: ctx.taskId,
		notice: "问题已登记，本步结束后会发给用户，并在用户回答后继续。现在结束这一步。",
	};
}

export async function waitUntil(options: TaskManageToolOptions, request: TaskWaitRequest): Promise<TaskManageResult> {
	const ctx = session(options);
	assertNoIntent(ctx, "task_wait");
	const until = parseWaitUntil(requiredField(request.until, "until", "task_wait"));
	ctx.intent().waitUntil = until;
	await appendTaskLog(options.deskDir, ctx.taskId, { kind: "wait", seq: ctx.seq(), until });
	return {
		action: "wait",
		id: ctx.taskId,
		notice: `约定等到 ${until}；期间有新结果或用户消息会提前叫醒你。现在结束这一步。`,
	};
}
