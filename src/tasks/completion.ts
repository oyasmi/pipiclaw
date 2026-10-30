import { RecoverableToolError } from "../shared/recoverable-error.js";
import type { TaskStepIntent } from "./control.js";
import { lastStep, type TaskLogRecord, type TaskReportRecord } from "./loop-log.js";

/** A durable close always wins over ordinary scheduling, including after restart. */
export function pendingTaskClose(records: readonly TaskLogRecord[]): TaskStepIntent["close"] {
	const latest = [...records]
		.reverse()
		.find((record) => record.kind === "step_end" || record.kind === "close" || record.kind === "close_rejected");
	if (latest?.kind === "step_end") return latest.close;
	if (latest?.kind === "close")
		return {
			outcome: latest.outcome === "done" ? "complete" : "cancel",
			note: latest.note,
			reportId: latest.reportId,
		};
	return undefined;
}

/** Bind completion to this step's specific final report, never an old progress update. */
export function finalTaskReport(
	records: readonly TaskLogRecord[],
	options: { seq?: number; fromChat?: boolean } = {},
): TaskReportRecord & { id: string } {
	const seq = options.seq ?? lastStep(records)?.step.seq;
	const report = [...records].reverse().find((record) => record.kind === "report" && record.seq === seq);
	if (report?.kind !== "report" || !report.id) {
		throw new RecoverableToolError(
			options.fromChat
				? "Completion needs the leader's final report. Use task_message to ask the task to finish; if paused, use task_resume, then let the leader report and close."
				: "Completion needs a final report from the current step. Use task_report to deliver the results and evidence, then call task_close again.",
		);
	}
	return report as TaskReportRecord & { id: string };
}

export function taskReportDelivered(
	records: readonly TaskLogRecord[],
	reportId: string | undefined,
	channel?: string,
): boolean {
	return (
		!!reportId &&
		records.some(
			(record) =>
				record.kind === "report" &&
				record.id === reportId &&
				record.delivered &&
				(channel === undefined || record.channel === channel),
		)
	);
}
