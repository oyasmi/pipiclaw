import { applyTaskItemsPatch, normalizeTaskId } from "../../tasks/ledger.js";
import { appendTaskLog } from "../../tasks/log.js";
import { queueTaskNotice } from "../../tasks/steer.js";
import { readStoredTask, writeStoredTask } from "../../tasks/store.js";
import { describeTicket, resolveTicket } from "../../tasks/ticket.js";
import { RecoverableToolError } from "../tool-details.js";
import { buildTicketContext, closeTaskDocument, requiredField } from "./shared.js";
import type { TaskManageResult, TaskManageToolOptions, TaskStepEndRequest } from "./types.js";

/**
 * `task_step_end` — the loop's only closing move (spec 051, D4/§12.4; narrowed by spec 052, D7).
 *
 * One tool with three outcomes: the model states an *intent* ("keep going", "wait for this",
 * "we're done") and the runtime derives the state, so an illegal combination — parked with
 * nothing to wait for, active with a future wake — is not expressible rather than merely
 * diagnosed afterwards. Asking the user is not a fourth outcome but a park on an `ask` ticket,
 * which the runtime also announces.
 */
export async function endTaskStep(
	options: TaskManageToolOptions,
	request: TaskStepEndRequest,
): Promise<TaskManageResult> {
	if (!options.taskId) {
		throw new RecoverableToolError("task_step_end is only available inside a task loop step.");
	}
	const id = normalizeTaskId(options.taskId);
	const document = await readStoredTask(options.channelDir, id);
	if (!document) throw new RecoverableToolError(`Task "${id}" no longer exists; nothing to end.`);
	const note = requiredField(request.note, "note", "task_step_end");

	if (request.items?.length) {
		document.body = applyTaskItemsPatch(document.body, request.items).body;
	}

	const seq = (document.fields.usage?.steps ?? 0) + 1;
	// The step's own model cost joins the task's usage here, before a `done` writes its close
	// record; bound delegations add theirs when they settle. A rough figure by design.
	const cost = options.getStepCost?.();
	const usd = cost && cost.usd > 0 ? cost.usd : 0;
	const usdEstimated = cost?.estimated === true;
	const usage = document.fields.usage;
	if (usage) {
		document.fields.usage = {
			...usage,
			steps: seq,
			usd: usage.usd + usd,
			usdEstimated: usage.usdEstimated || usdEstimated,
		};
	}

	const tools = [...new Set(options.getToolsUsed?.() ?? [])];
	const report = request.report?.trim();
	const logStep = async (outcome: TaskStepEndRequest["outcome"]) => {
		await appendTaskLog(options.channelDir, id, {
			kind: "step",
			seq,
			outcome,
			note,
			tools,
			...(report ? { report } : {}),
			...(usd > 0 ? { usd } : {}),
			...(usdEstimated ? { usdEstimated: true } : {}),
		});
	};

	// Steps are silent by default (D9); `report` is the explicit opt-in the runtime delivers once
	// the step ends. The notice is an *outbound side effect*: it must not land before every
	// recoverable check (required fields, unmet acceptance items, work in flight, ticket
	// resolution) has passed, or a rejected `outcome=done` still tells the channel "task complete"
	// and a corrected retry queues a second notice. So it is computed here and only flushed past a
	// successful write, right before each return.
	let pendingNotice = report || undefined;
	const flushNotice = async () => {
		if (pendingNotice) await queueTaskNotice(options.channelDir, id, pendingNotice);
	};

	if (request.outcome === "done") {
		await closeTaskDocument({
			options,
			document,
			id,
			outcome: "complete",
			note,
			steps: seq,
			afterChecks: () => logStep("done"),
		});
		await flushNotice();
		return {
			action: "step_end",
			id,
			archived: true,
			notice: `任务 \`${id}\` 已完成并归档。`,
		};
	}

	let notice: string;
	if (request.outcome === "continue") {
		document.fields.state = "open";
		document.fields.ticket = undefined;
		notice = `步骤已记录，任务 \`${id}\` 继续。`;
	} else {
		if (!request.ticket) {
			throw new RecoverableToolError(
				"task_step_end outcome=park requires a ticket describing what will wake this task.",
			);
		}
		const context = await buildTicketContext(options, id);
		const ticket = resolveTicket(request.ticket, context);
		document.fields.state = "parked";
		document.fields.ticket = ticket;
		// A task waiting on the user that says nothing is the same silent dead end tickets exist to
		// prevent, so an `ask` park always speaks.
		if (ticket.kind === "ask") {
			pendingNotice = [report, `任务 ${id} 需要你的决定：${ticket.asked}\n用 /tasks reply ${id} <内容> 回答。`]
				.filter(Boolean)
				.join("\n\n");
		}
		notice = `任务 \`${id}\` 已停泊：${describeTicket(ticket)}（兜底 ${ticket.by}）。`;
	}

	await writeStoredTask(document);
	await logStep(request.outcome);
	await flushNotice();
	return { action: "step_end", id, state: document.fields.state, notice };
}
