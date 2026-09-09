import { renderCloseSummary, writeLastResult } from "../../tasks/cycle.js";
import { applyTaskPlanPatch, normalizeTaskId, uncheckedTaskAcceptanceItems } from "../../tasks/ledger.js";
import { appendTaskLog } from "../../tasks/log.js";
import { queueTaskNotice } from "../../tasks/steer.js";
import { archiveTask, readStoredTask, writeStoredTask } from "../../tasks/store.js";
import { describeTicket, resolveTicket } from "../../tasks/ticket.js";
import { RecoverableToolError } from "../tool-details.js";
import { assertVerificationHoldsForClose, buildTicketContext, cleanupTaskEvents, requiredField } from "./shared.js";
import type { TaskManageResult, TaskManageToolOptions, TaskStepEndRequest } from "./types.js";

/**
 * `task_step_end` — the loop's only closing move (spec 051, D4/§12.4).
 *
 * One tool with four outcomes replaces v3's `task_update(note)` + `task_close` + the
 * status/wake/waitingFor triple the model had to keep mutually consistent. The model states an
 * *intent* ("keep going", "wait for this", "we're done", "I'm stuck") and the runtime derives the
 * state, so an illegal combination — parked with nothing to wait for, active with a future wake —
 * is not expressible rather than merely diagnosed afterwards by `/tasks doctor`.
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
	const cycleId = document.fields.cycle?.id ?? options.cycleId ?? "-";
	const note = requiredField(request.note, "note", "task_step_end");
	// Also reject stale callers that bypass the schema, which no longer exposes schedule tickets.
	if (request.outcome === "park" && (request.ticket?.kind as string | undefined) === "schedule") {
		throw new RecoverableToolError(
			"To finish this cycle, use outcome=done with summary and evidence; the runtime schedules the next occurrence. To skip it, use task_close outcome=skip with a reason. Use a time ticket to wait within this cycle.",
		);
	}

	if (request.planSteps?.length) {
		document.body = applyTaskPlanPatch(document.body, request.planSteps).body;
	}

	const seq = (document.fields.cycle?.steps ?? 0) + 1;
	if (document.fields.cycle) document.fields.cycle = { ...document.fields.cycle, steps: seq };

	const tools = [...new Set(options.getToolsUsed?.() ?? [])];
	const logStep = async (outcome: TaskStepEndRequest["outcome"]) => {
		await appendTaskLog(options.channelDir, id, { cycle: cycleId, kind: "step", seq, outcome, note, tools });
	};
	// Steps are silent by default (D3); `notify` is the explicit opt-in the runtime delivers once
	// the step ends. `blocked` always speaks — a task waiting on the user that says nothing is the
	// same silent dead end tickets exist to prevent.
	if (request.notify?.trim()) await queueTaskNotice(options.channelDir, id, request.notify);
	else if (request.outcome === "blocked") {
		await queueTaskNotice(options.channelDir, id, `任务 ${id} 需要你的决定：${request.reason ?? note}`);
	}

	if (request.outcome === "done") {
		const summary = requiredField(request.summary, "summary", "task_step_end outcome=done");
		const evidence = requiredField(request.evidence, "evidence", "task_step_end outcome=done");
		const unchecked = uncheckedTaskAcceptanceItems(document.body);
		if (unchecked.length > 0) {
			throw new RecoverableToolError(
				`Task "${id}" still has unmet acceptance items: ${unchecked.slice(0, 3).join("; ")}. Check them off with edit once the evidence holds.`,
			);
		}
		// Verification is imported by the runtime when a purpose=verify run settles (D7), so what
		// gates `done` here is the cycle's verification ledger — not whether the model remembered to
		// call an import tool. The settled verdict is re-bound to the contract and the checkout as
		// they are *now*: a PASS is evidence about the artifact the verifier saw, and the loop can
		// edit both after it lands.
		await assertVerificationHoldsForClose(options, document, id);
		const cycle = document.fields.cycle;
		document.body = writeLastResult(
			document.body,
			renderCloseSummary({
				cycleId,
				outcome: "done",
				summary,
				evidence,
				residualRisk: request.residualRisk,
				steps: cycle?.steps ?? seq,
				rounds: cycle?.rounds ?? 0,
				usd: cycle?.usd ?? 0,
				usdEstimated: cycle?.usdEstimated ?? false,
			}),
		);
		await appendTaskLog(options.channelDir, id, {
			cycle: cycleId,
			kind: "close",
			outcome: "done",
			summary,
			evidence,
			residualRisk: request.residualRisk,
			steps: cycle?.steps ?? seq,
			rounds: cycle?.rounds ?? 0,
			usd: cycle?.usd ?? 0,
		});

		if (document.fields.schedule) {
			// Recurring: park on the next occurrence rather than archiving. The contract, the Plan
			// and the loop log all survive into the next cycle; only the counters reset.
			const context = await buildTicketContext(options, id, document.fields.schedule);
			const ticket = resolveTicket({ kind: "schedule" }, context);
			document.fields.state = "parked";
			document.fields.ticket = ticket;
			await writeStoredTask(document);
			await logStep("done");
			return {
				action: "step_end",
				id,
				state: "parked",
				notice: `任务 \`${id}\` 本周期完成，${describeTicket(ticket)}。`,
			};
		}
		await writeStoredTask(document);
		await logStep("done");
		const { deleted } = await cleanupTaskEvents(options, id);
		await archiveTask(options.channelDir, id, "completed");
		return {
			action: "step_end",
			id,
			archived: true,
			deletedEvents: deleted,
			notice: `任务 \`${id}\` 已完成并归档。`,
		};
	}

	let notice: string;
	if (request.outcome === "continue") {
		document.fields.state = "open";
		document.fields.ticket = undefined;
		notice = `步骤已记录，任务 \`${id}\` 继续。`;
	} else {
		// `blocked` is `park` on an `ask` ticket: a task that needs the user is still a task with a
		// verifiable, backstopped wait, not a special state that could go quiet.
		const input =
			request.outcome === "blocked"
				? { kind: "ask", asked: requiredField(request.reason, "reason", "task_step_end outcome=blocked") }
				: request.ticket;
		if (!input) {
			throw new RecoverableToolError(
				"task_step_end outcome=park requires a ticket describing what will wake this task.",
			);
		}
		const context = await buildTicketContext(options, id, document.fields.schedule);
		const ticket = resolveTicket(input, context);
		document.fields.state = "parked";
		document.fields.ticket = ticket;
		notice = `任务 \`${id}\` 已停泊：${describeTicket(ticket)}（兜底 ${ticket.by}）。`;
	}

	await writeStoredTask(document);
	await logStep(request.outcome);
	return { action: "step_end", id, state: document.fields.state, notice };
}
