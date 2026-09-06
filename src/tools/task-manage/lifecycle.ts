import { mkdir } from "node:fs/promises";
import { renderCloseSummary, writeLastResult } from "../../tasks/cycle.js";
import {
	applyTaskPlanPatch,
	normalizeTaskId,
	readActiveTasks,
	uncheckedTaskAcceptanceItems,
} from "../../tasks/ledger.js";
import { appendTaskLog } from "../../tasks/log.js";
import { archiveTask, readStoredTask, writeStoredTask } from "../../tasks/store.js";
import { describeTicket, resolveTicket } from "../../tasks/ticket.js";
import { RecoverableToolError } from "../tool-details.js";
import {
	assertVerificationHoldsForClose,
	buildTicketContext,
	cleanupTaskEvents,
	describeTaskState,
	normalizeBudget,
	normalizeSchedule,
	renderCloseEvidence,
	requiredField,
	tasksDir,
} from "./shared.js";
import type { TaskCloseRequest, TaskManageResult, TaskManageToolOptions, TaskUpdateRequest } from "./types.js";

async function requireTask(options: TaskManageToolOptions, id: string) {
	const document = await readStoredTask(options.channelDir, id);
	if (!document) {
		throw new RecoverableToolError(`Task "${id}" does not exist; create it with task_create first.`);
	}
	return document;
}

/**
 * `task_update` is metadata only (spec 051, D4): plan steps, cadence, budget, and whether a done
 * needs an independent PASS. Progress notes are no longer written here — they belong to the loop
 * log via `task_step_end`, which is the only writer that can also change what the task is waiting
 * for. Keeping the two apart is what stops "checkpoint" from quietly becoming a state transition.
 */
export async function updateTask(
	options: TaskManageToolOptions,
	request: TaskUpdateRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const document = await requireTask(options, id);

	const changes: string[] = [];
	if (request.planSteps?.length) {
		const patched = applyTaskPlanPatch(document.body, request.planSteps);
		document.body = patched.body;
		if (patched.summary) changes.push(patched.summary);
	}
	const schedule = normalizeSchedule(request.schedule);
	if (schedule !== undefined) {
		document.fields.schedule = schedule ?? undefined;
		changes.push(schedule ? `schedule=${schedule}` : "schedule 已清除");
	}
	const budget = normalizeBudget(request.budget);
	if (budget) {
		document.fields.budget = { ...document.fields.budget, ...budget };
		changes.push("budget 已更新");
	}
	if (request.verificationRequired !== undefined) {
		document.fields.verify = request.verificationRequired ? "required" : undefined;
		changes.push(`verify=${request.verificationRequired ? "required" : "off"}`);
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
 * Close a task from the chat surface: `complete` archives it, `cancel` archives it as abandoned,
 * `skip` closes the current recurring occurrence and parks on the next one. The loop's own
 * `task_step_end outcome=done` shares the same close-out path.
 */
export async function closeTask(options: TaskManageToolOptions, request: TaskCloseRequest): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const document = await requireTask(options, id);
	const cycleId = document.fields.cycle?.id ?? "-";

	if (request.outcome === "complete") {
		const unchecked = uncheckedTaskAcceptanceItems(document.body);
		if (unchecked.length > 0) {
			throw new RecoverableToolError(
				`Task "${id}" still has unmet acceptance items: ${unchecked.slice(0, 3).join("; ")}. Check them off with edit once the evidence holds.`,
			);
		}
		await assertVerificationHoldsForClose(options, document, id);
		const evidence = renderCloseEvidence(request);
		document.body = writeLastResult(document.body, evidence);
		await writeStoredTask(document);
		await appendTaskLog(options.channelDir, id, {
			cycle: cycleId,
			kind: "close",
			outcome: "done",
			summary: requiredField(request.summary, "summary", "task_close outcome=complete"),
			evidence: request.evidence,
			residualRisk: request.residualRisk,
			steps: document.fields.cycle?.steps ?? 0,
			rounds: document.fields.cycle?.rounds ?? 0,
			usd: document.fields.cycle?.usd ?? 0,
		});
		const { deleted } = await cleanupTaskEvents(options, id);
		await archiveTask(options.channelDir, id, "completed");
		return {
			action: "close",
			id,
			archived: true,
			deletedEvents: deleted,
			notice: `任务 \`${id}\` 已完成并归档。`,
		};
	}

	if (request.outcome === "cancel") {
		const reason = requiredField(request.reason, "reason", "task_close outcome=cancel");
		document.body = writeLastResult(document.body, `- 已取消：${reason}`);
		await writeStoredTask(document);
		await appendTaskLog(options.channelDir, id, {
			cycle: cycleId,
			kind: "close",
			outcome: "cancelled",
			summary: reason,
			steps: document.fields.cycle?.steps ?? 0,
			rounds: document.fields.cycle?.rounds ?? 0,
			usd: document.fields.cycle?.usd ?? 0,
		});
		const { deleted } = await cleanupTaskEvents(options, id);
		await archiveTask(options.channelDir, id, "cancelled");
		return { action: "close", id, archived: true, deletedEvents: deleted, notice: `任务 \`${id}\` 已取消并归档。` };
	}

	// skip: recurring only — park on the next occurrence without faking completion evidence.
	if (!document.fields.schedule) {
		throw new RecoverableToolError(
			`Task "${id}" is one-shot; skip applies to a recurring occurrence. Use outcome=cancel to abandon it.`,
		);
	}
	const reason = requiredField(request.reason, "reason", "task_close outcome=skip");
	const context = await buildTicketContext(options, id, document.fields.schedule);
	const ticket = resolveTicket({ kind: "schedule" }, context);
	document.body = writeLastResult(
		document.body,
		renderCloseSummary({
			cycleId,
			outcome: "cancelled",
			summary: `本次 occurrence 跳过：${reason}`,
			steps: document.fields.cycle?.steps ?? 0,
			rounds: document.fields.cycle?.rounds ?? 0,
			usd: document.fields.cycle?.usd ?? 0,
			usdEstimated: document.fields.cycle?.usdEstimated ?? false,
		}),
	);
	document.fields.state = "parked";
	document.fields.ticket = ticket;
	await writeStoredTask(document);
	await appendTaskLog(options.channelDir, id, {
		cycle: cycleId,
		kind: "close",
		outcome: "cancelled",
		summary: `skip: ${reason}`,
		steps: document.fields.cycle?.steps ?? 0,
		rounds: document.fields.cycle?.rounds ?? 0,
		usd: document.fields.cycle?.usd ?? 0,
	});
	return {
		action: "close",
		id,
		state: "parked",
		notice: `任务 \`${id}\` 本周期已跳过，${describeTicket(ticket)}。`,
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
		cycle: entry.fields.cycle?.id,
		steps: entry.fields.cycle?.steps,
		rounds: entry.fields.cycle?.rounds,
	}));
	return {
		action: "list",
		tasks,
		notice: tasks.length === 0 ? "暂无进行中的任务。" : `共 ${tasks.length} 个进行中的任务。`,
	};
}
