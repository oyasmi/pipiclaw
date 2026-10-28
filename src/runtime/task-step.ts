import type { AgentRunner } from "../agent/types.js";
import type { ChannelContext } from "../channel/channel-context.js";
import type { TurnInfo } from "../channel/transport.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { buildTaskStepBrief, contractOpenTag, contractSha, type PendingWorkView } from "../tasks/brief.js";
import type { TaskSessionContext, TaskStepIntent } from "../tasks/control.js";
import type { TaskStepResult } from "../tasks/loop-log.js";
import type { StepDerivation } from "../tasks/state.js";
import { beginStep, type EndedStep, endStep, readStoredTask } from "../tasks/store.js";
import type { LaneContext, LiveTask, StepAbort, TaskStepEvent } from "./task-lane-types.js";
import { listPendingWork } from "./task-pending.js";

/** A task step speaks to nobody: only `task_report`, `task_ask` and the lane's receipts reach a channel (INV-1). */
const SILENT_CONTEXT: ChannelContext = { emit: () => undefined, finish: async () => undefined };

/** The task session's view of its lane: which step is running and where it reports. */
function sessionContextOf(ctx: LaneContext, live: LiveTask): TaskSessionContext {
	return {
		taskId: live.taskId,
		seq: () => live.seq,
		intent: () => live.intent,
		report: async (text) => {
			try {
				return await ctx.options.deliver(live.desk, live.channelId, text);
			} catch (error) {
				log.logWarn("tasks.step.report_failed", "Task report delivery failed", {
					channelId: live.channelId,
					reason: errorMessage(error),
					fields: { taskId: live.taskId, desk: live.desk },
				});
				return false;
			}
		},
	};
}

/** The task's runner, built on first use and kept until the task leaves execution (D13). */
export function ensureRunner(ctx: LaneContext, live: LiveTask): AgentRunner {
	if (live.runner) return live.runner;
	live.runner = ctx.options.createTaskRunner({
		desk: live.desk,
		deskDir: live.deskDir,
		taskId: live.taskId,
		channelId: live.channelId,
		session: sessionContextOf(ctx, live),
	});
	return live.runner;
}

/** Stop the running step: the turn is asked to end, and the abort cuts a tool that would not. */
export function abortStep(live: LiveTask, reason: StepAbort): void {
	const step = live.step;
	if (!step || step.abort) return;
	step.abort = reason;
	const runner = live.runner;
	if (!runner) return;
	runner.requestStop();
	void runner.abort().catch((error: unknown) => {
		log.logWarn("tasks.step.abort_failed", "Task step abort failed", {
			channelId: live.channelId,
			reason: errorMessage(error),
			fields: { taskId: live.taskId, desk: live.desk },
		});
	});
}

function notifyStep(ctx: LaneContext, event: TaskStepEvent): void {
	try {
		ctx.options.onStep?.(event);
	} catch (error) {
		log.logWarn("tasks.step.observer_failed", "Task step observer failed", { reason: errorMessage(error) });
	}
}

/** What a finished step tells the drive loop. */
export type StepReport =
	/** The task is gone, or was paused or moved to a wait since the lane decided to run it: nothing ran. */
	| { kind: "skipped" }
	/** The process is stopping: the step's `step_end` is written by the next start's reconciliation (D10). */
	| { kind: "interrupted" }
	| {
			kind: "ended";
			result: TaskStepResult;
			ended: EndedStep | undefined;
			derivation: StepDerivation;
			intent: TaskStepIntent;
	  };

/**
 * One step (spec 064, D14): write the `step` record, build the brief, run the turn in the task's
 * own session with a time limit, and write what happened. The state that follows is derived from the
 * step's facts inside `endStep`, not declared by the model (INV-2).
 */
export async function executeStep(ctx: LaneContext, live: LiveTask): Promise<StepReport> {
	const { options } = ctx;
	const document = await readStoredTask(live.deskDir, live.taskId);
	if (!document || document.fields.outcome) return { kind: "skipped" };

	const runner = ensureRunner(ctx, live);
	// Whether the session still holds the current contract is read from the session itself, so a
	// compaction that dropped it, or an edit that changed it, brings the full brief back (D15).
	const full = !(await runner.contextIncludes(contractOpenTag(live.taskId, contractSha(document.body))));
	const begun = await beginStep(live.deskDir, live.taskId, { brief: full ? "full" : "delta" });
	if (!begun) return { kind: "skipped" };

	live.seq = begun.seq;
	live.intent = { reports: 0 };
	const now = ctx.now();
	const pendingMap = await listPendingWork(options, live.desk, now);
	const pending: PendingWorkView[] = (pendingMap.get(live.taskId) ?? []).map((work) => ({
		ref: work.ref,
		label: work.label,
		runningMs: now - work.startedAt,
	}));
	const brief = await buildTaskStepBrief({
		deskDir: live.deskDir,
		document: begun.document,
		seq: begun.seq,
		records: begun.records,
		inputs: begun.inputs,
		full,
		pending,
		now,
	});

	const step: NonNullable<LiveTask["step"]> = { seq: begun.seq, startedAt: now };
	live.step = step;
	step.timer = setTimeout(() => abortStep(live, "timeout"), ctx.timing.stepTimeLimitMs);
	step.timer.unref?.();
	const info: TurnInfo = {
		channelId: live.channelId,
		user: "TASK",
		userName: "TASK",
		text: brief.text,
		ts: String(now),
	};
	notifyStep(ctx, { phase: "started", desk: live.desk, taskId: live.taskId, seq: begun.seq });
	log.logInfoEvent("tasks.step.started", "Task step started", {
		channelId: live.channelId,
		fields: {
			taskId: live.taskId,
			desk: live.desk,
			seq: begun.seq,
			reason: begun.reason,
			brief: full ? "full" : "delta",
		},
	});

	let result: TaskStepResult = "ok";
	let error: string | undefined;
	let finalText = "";
	let toolsUsed: string[] = [];
	let usd = 0;
	let usdEstimated = false;
	try {
		const run = await runner.run(info, SILENT_CONTEXT, options.store);
		finalText = run.finalText ?? "";
		toolsUsed = run.toolsUsed ?? [];
		usd = run.assistantCost?.usd ?? 0;
		usdEstimated = run.assistantCost?.estimated === true;
		if (run.stopReason === "error") {
			result = "error";
			error = run.errorMessage;
		} else if (run.stopReason === "aborted") {
			result = "aborted";
		}
	} catch (cause) {
		result = "error";
		error = errorMessage(cause);
	} finally {
		if (step.timer) clearTimeout(step.timer);
	}
	live.step = undefined;

	// A stop from the lane decides the result whatever the turn reported on its way out.
	switch (step.abort) {
		case "shutdown":
			return { kind: "interrupted" };
		case "timeout":
			result = "timeout";
			break;
		case "pause":
		case "cancel":
			result = "aborted";
			break;
		case undefined:
			break;
	}

	// The leader's intent counts only if the step went well: a step that failed or was cut off
	// did not finish what it started, so it is re-run rather than half-believed.
	const intent = live.intent;
	const honoured = result === "ok";
	const ended = await endStep(live.deskDir, live.taskId, {
		seq: begun.seq,
		result,
		note: finalText.trim() || "（无）",
		tools: toolsUsed,
		usd,
		usdEstimated,
		...(error ? { error } : {}),
		facts: {
			result,
			closed: honoured && intent.close !== undefined,
			pausedByUser: step.abort === "pause",
			...(honoured && intent.ask ? { asked: intent.ask } : {}),
			...(honoured && intent.waitUntil ? { waitUntil: intent.waitUntil } : {}),
			pendingWork: (await listPendingWork(options, live.desk, ctx.now())).get(live.taskId)?.length ?? 0,
		},
	});
	notifyStep(ctx, {
		phase: "ended",
		desk: live.desk,
		taskId: live.taskId,
		seq: begun.seq,
		result,
		...(ended ? { next: ended.derivation.next } : {}),
	});
	log.logInfoEvent("tasks.step.ended", "Task step ended", {
		channelId: live.channelId,
		fields: { taskId: live.taskId, desk: live.desk, seq: begun.seq, result, next: ended?.derivation.next },
	});
	return {
		kind: "ended",
		result,
		ended,
		derivation: ended?.derivation ?? { next: "continue", state: "queued", keepSlot: false },
		intent,
	};
}
