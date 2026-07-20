import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { ChannelJobManager, JobSnapshot } from "../agent/job-manager.js";
import { truncateTail } from "./truncate.js";

const jobSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're checking (shown to user)" }),
	op: Type.Union([Type.Literal("list"), Type.Literal("poll"), Type.Literal("cancel")], {
		description:
			'"list" a snapshot of background jobs, "poll" to wait (briefly) for one to finish, or "cancel" jobs by id.',
	}),
	ids: Type.Optional(
		Type.Array(Type.String(), {
			description: "Job ids for poll/cancel. For poll, omit to watch all running jobs.",
		}),
	),
});

export interface JobToolOptions {
	jobManager: ChannelJobManager;
}

interface JobToolArgs {
	label: string;
	op: "list" | "poll" | "cancel";
	ids?: string[];
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function formatJobLine(job: JobSnapshot): string {
	const exit = job.exitCode !== undefined ? `, exit ${job.exitCode}` : "";
	return `- [${job.id}] ${job.label} — ${job.status} (${formatDuration(job.durationMs)}${exit})`;
}

export function createJobTool(options: JobToolOptions): AgentTool<typeof jobSchema> {
	const { jobManager } = options;

	async function completedDetail(jobs: JobSnapshot[]): Promise<string[]> {
		const sections: string[] = [];
		for (const job of jobs) {
			const output = await jobManager.readOutput(job.id);
			const tail = output ? truncateTail(output.text).content : "";
			const body = tail.trim() ? tail : "(no output)";
			const path = output ? `\nFull output: ${output.spillFile}` : "";
			sections.push(
				`### [${job.id}] ${job.label} — ${job.status}${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""}\n${body}${path}`,
			);
		}
		return sections;
	}

	return {
		name: "job",
		label: "job",
		description:
			"Inspect and control background bash jobs (started with bash async:true). op=list shows a snapshot; " +
			"op=poll waits briefly for a running job to finish and returns its output; op=cancel stops jobs by id. " +
			"A finished job wakes this channel by itself, so never schedule a check-in for one — end the turn instead.",
		parameters: jobSchema,
		execute: async (_toolCallId: string, { op, ids }: JobToolArgs, signal?: AbortSignal) => {
			if (op === "cancel") {
				if (!ids || ids.length === 0) {
					throw new Error("cancel requires at least one job id.");
				}
				const outcomes = await jobManager.cancel(ids, signal);
				const text = outcomes.map((outcome) => `- [${outcome.id}] ${outcome.status}`).join("\n");
				return {
					content: [{ type: "text", text: `Cancel results:\n${text}` }],
					details: { kind: "job", op: "cancel", outcomes },
				};
			}

			if (op === "list") {
				const jobs = await jobManager.list(signal);
				if (jobs.length === 0) {
					return {
						content: [{ type: "text", text: "No background jobs." }],
						details: { kind: "job", op: "list", jobs },
					};
				}
				return {
					content: [{ type: "text", text: jobs.map(formatJobLine).join("\n") }],
					details: { kind: "job", op: "list", jobs },
				};
			}

			// poll
			const jobs = await jobManager.poll(ids, signal);
			if (jobs.length === 0) {
				return {
					content: [{ type: "text", text: "No matching running jobs to wait for." }],
					details: { kind: "job", op: "poll", jobs },
				};
			}
			const finished = jobs.filter((job) => job.status !== "running");
			const running = jobs.filter((job) => job.status === "running");
			const parts: string[] = [];
			if (finished.length > 0) {
				parts.push(`## Finished (${finished.length})`, ...(await completedDetail(finished)));
			}
			if (running.length > 0) {
				parts.push(`## Still running (${running.length})`, ...running.map(formatJobLine));
				parts.push("Poll again to keep waiting, or just end your turn — you are woken when the job finishes.");
			}
			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { kind: "job", op: "poll", jobs },
			};
		},
	};
}
