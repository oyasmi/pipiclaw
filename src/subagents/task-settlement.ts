import { join } from "node:path";
import { logTaskSettlement } from "../tasks/bound-work.js";
import { WAKE_OUTPUT_TAIL_CHARS } from "./completion-wake.js";
import type { RunRecord, SettleInput } from "./run-record.js";

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
			verdict: record.purpose === "verify" ? record.verificationVerdict : undefined,
			output: outputSaved ? join(record.artifactDir, "output.md") : undefined,
			tail: input.outputText.slice(-WAKE_OUTPUT_TAIL_CHARS).trim() || undefined,
			changed: record.workspaceSummary,
			durationMs: input.durationMs,
			...(inline ? { inline: true } : {}),
		},
		{ usd: input.usage.cost.total, estimated: input.costKnown === false },
	);
}
