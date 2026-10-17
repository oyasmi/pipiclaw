/**
 * The two observability records a settled run leaves behind: its usage-ledger entry and its
 * `subagent-runs.jsonl` archive entry. Pure shaping only — *when* they are written, and the
 * idempotency marker that keeps a replayed settlement from writing them twice, stay with
 * `SubAgentRunManager.settle`.
 */
import type { LoggedSubAgentRun } from "../channel/store.js";
import type { UsageLedgerEntry } from "../usage/ledger.js";
import type { RunRecord, SettleInput } from "./run-record.js";

/** Archived output is capped; the full text is in the run's `output.md`. */
const ARCHIVED_OUTPUT_MAX_CHARS = 16_000;

export function runLedgerEntry(dot: string, record: RunRecord, input: SettleInput): Omit<UsageLedgerEntry, "ts"> {
	return {
		channelId: record.channelId,
		dot,
		kind: "subagent",
		model: record.model ?? "unknown",
		label: record.label,
		runId: record.runId,
		taskId: record.taskId,
		usage: {
			input: input.usage.input,
			output: input.usage.output,
			cacheRead: input.usage.cacheRead,
			cacheWrite: input.usage.cacheWrite,
			total: input.usage.total,
		},
		cost: { ...input.usage.cost },
		usageKnown: input.usageKnown,
		costKnown: input.costKnown,
	};
}

export function runArchiveEntry(
	record: RunRecord,
	input: SettleInput,
	status: SettleInput["status"],
): LoggedSubAgentRun {
	const truncated = input.outputText.length > ARCHIVED_OUTPUT_MAX_CHARS;
	return {
		date: new Date().toISOString(),
		toolCallId: record.runId,
		label: record.label,
		agent: record.agent,
		source: record.source,
		model: record.model ?? "unknown",
		tools: record.tools,
		turns: input.turns,
		toolCalls: input.toolCalls,
		durationMs: input.durationMs,
		failed: input.status !== "completed",
		failureReason: input.failureReason,
		output: truncated ? input.outputText.slice(0, ARCHIVED_OUTPUT_MAX_CHARS) : input.outputText,
		outputTruncated: truncated,
		usage: { ...input.usage, cost: { ...input.usage.cost } },
		runId: record.runId,
		runtime: record.runtime,
		harness: record.harness,
		status,
		taskId: record.taskId,
		artifactDir: record.artifactDir,
	};
}
