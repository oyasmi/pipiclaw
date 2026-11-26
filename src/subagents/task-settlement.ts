import { join } from "node:path";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { logTaskSettlement, logTaskStall } from "../tasks/bound-work.js";
import { WAKE_OUTPUT_TAIL_CHARS } from "./completion-wake.js";
import type { RunRecord, SettleInput } from "./run-record.js";

/** The task decides what to do when one of its runs goes quiet (spec 064 D16). */
export async function notifyTaskRunStall(
	deskDir: string,
	taskId: string,
	runId: string,
	silentMs: number,
	onTaskInput: () => void,
): Promise<void> {
	try {
		const logged = await logTaskStall(deskDir, taskId, {
			ref: runId,
			silentMinutes: Math.max(1, Math.round(silentMs / 60_000)),
		});
		if (logged) onTaskInput();
	} catch (error) {
		log.logWarn("subagent.task_stall.log_failed", "Task stall record for run failed", {
			reason: errorMessage(error),
			fields: { runId, taskId },
		});
	}
}

/** Map settled run facts to the task journal; the run manager owns acknowledgment and retries. */
export async function creditTaskForRun(
	deskDir: string,
	record: RunRecord,
	input: Pick<SettleInput, "outputText" | "durationMs" | "usage" | "costKnown">,
	outputSaved: boolean,
	inline: boolean,
): Promise<void> {
	const taskId = record.taskId;
	if (!taskId) return;
	await logTaskSettlement(
		deskDir,
		taskId,
		{
			ref: record.runId,
			item: record.item,
			status: record.status,
			...(record.status === "failed" && {
				failureKind: record.failureKind,
				failurePreExecution: record.failurePreExecution,
			}),
			verdict: record.purpose === "verify" ? record.verificationVerdict : undefined,
			output: outputSaved ? join(record.artifactDir, "output.md") : undefined,
			tail: input.outputText.slice(-WAKE_OUTPUT_TAIL_CHARS).trim() || undefined,
			changed: record.workspaceSummary,
			...(record.worktree ? { worktree: record.worktree } : {}),
			durationMs: input.durationMs,
			...(inline ? { inline: true } : {}),
		},
		{ usd: input.usage.cost.total, estimated: false, known: input.costKnown },
	);
}
