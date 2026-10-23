/**
 * The completion wake a finished background job sends to the channel that started it (spec 031,
 * D6; spec 058, D7).
 */
import type { ChannelEvent } from "../channel/channel-event.js";
import { conversationTypeOf } from "../channel/channel-id.js";
import type { JobRecord } from "./record.js";

/** The wake's dispatch id — the only id `beginWakeConsumption` accepts for it. */
export function jobWakeDispatchId(desk: string, jobId: string): string {
	return `job:${desk}:${jobId}:done`;
}

export function buildJobCompletionWake(input: {
	desk: string;
	channelId: string;
	record: JobRecord;
	tail: string | undefined;
}): ChannelEvent {
	const { desk, channelId, record, tail } = input;
	const exit = record.exitCode !== undefined ? `exit ${record.exitCode}` : record.status;
	const seconds = Math.round(record.durationMs / 1000);
	const belongsTo = record.contract.taskId ? ` It belongs to task ${record.contract.taskId}.` : "";
	const conversationType = conversationTypeOf(channelId);
	const dispatchId = jobWakeDispatchId(desk, record.id);
	return {
		type: conversationType === "2" ? "group" : "dm",
		channelId,
		user: "JOB",
		userName: "JOB",
		text:
			`[JOB:${record.id}] Background job "${record.label}" finished: ${record.status} (${exit}, ${seconds}s).${belongsTo} ` +
			`Command: ${record.command}\n` +
			`Output tail:\n${tail || "(no output)"}\n` +
			`Full output: ${record.spillFile}\n` +
			"Continue whatever was waiting on this job. If it needs no follow-up, respond with exactly [SILENT].",
		ts: String(Date.now()),
		conversationType,
		dispatchId,
		desk,
		// The result is awaited; the wake itself still runs without a progress card.
		presentation: "awaited",
		...(record.contract.taskId
			? {
					internalWake: {
						kind: "job" as const,
						resourceId: record.id,
						taskId: record.contract.taskId,
						dispatchId,
					},
				}
			: {}),
	};
}
