import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { DotJobManager } from "../jobs/manager.js";
import type { JobSnapshot } from "../jobs/record.js";
import { formatDuration } from "../shared/format.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { truncateTail } from "./truncate.js";

const jobSchema = Type.Object({
	op: Type.Union([Type.Literal("list"), Type.Literal("poll"), Type.Literal("cancel")], {
		description:
			'"list" a snapshot of background jobs, "poll" to wait (briefly) for one to finish, or "cancel" jobs by id.',
	}),
	ids: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Job ids for poll/cancel. For poll, omit to watch every job running when the call starts " +
				"(a job started later is not folded into that same poll).",
		}),
	),
});

export interface JobToolOptions {
	jobManager: DotJobManager;
	/** The calling channel: a job another channel of this dot started is labelled with its origin. */
	channelId: string;
}

/** Total bytes of job output `op=poll` inlines across all finished jobs in one call. */
const COMPLETED_DETAIL_TOTAL_BUDGET = 96 * 1024;

interface JobToolArgs {
	op: "list" | "poll" | "cancel";
	ids?: string[];
}

export function createJobTool(options: JobToolOptions): AgentTool<typeof jobSchema> {
	const { jobManager } = options;

	function formatJobLine(job: JobSnapshot): string {
		const exit = job.exitCode !== undefined ? `, exit ${job.exitCode}` : "";
		const origin = job.channelId && job.channelId !== options.channelId ? `, started in ${job.channelId}` : "";
		return `- [${job.id}] ${job.label} — ${job.status} (${formatDuration(job.durationMs)}${exit}${origin})`;
	}

	async function completedDetail(jobs: JobSnapshot[]): Promise<string[]> {
		const sections: string[] = [];
		let spent = 0;
		for (const job of jobs) {
			const header = `### [${job.id}] ${job.label} — ${job.status}${job.exitCode !== undefined ? `, exit ${job.exitCode}` : ""}`;
			const output = await jobManager.readOutput(job.id);
			// Total budget across all finished jobs in one poll: 5 jobs × the 50KB per-job tail would
			// otherwise be 250KB of context. Once spent, later jobs get a header + a pointer only.
			if (spent >= COMPLETED_DETAIL_TOTAL_BUDGET) {
				sections.push(
					`${header}\n(output omitted to stay within budget — run \`job op=poll ids=["${job.id}"]\` for it)${output ? `\nFull output: ${output.spillFile}` : ""}`,
				);
				continue;
			}
			const tail = output ? truncateTail(output.text).content : "";
			const body = tail.trim() ? tail : "(no output)";
			const path = output ? `\nFull output: ${output.spillFile}` : "";
			spent += Buffer.byteLength(body, "utf-8");
			sections.push(`${header}\n${body}${path}`);
		}
		return sections;
	}

	return {
		name: "job",
		label: "job",
		description:
			"Inspect and control this dot's background bash jobs (started with bash async:true), shared by every " +
			"channel bound to it. op=list shows a snapshot; op=poll waits briefly for a running job to finish and " +
			"returns its output; op=cancel stops jobs by id. A job's completion wakes the channel that started it " +
			'(a job from another channel is marked "started in <channel>"); for your own jobs, finish independent ' +
			"work, then end the turn when only waiting remains.",
		parameters: jobSchema,
		execute: async (_toolCallId: string, { op, ids }: JobToolArgs, signal?: AbortSignal) => {
			if (op === "cancel") {
				if (!ids || ids.length === 0) {
					throw new RecoverableToolError("cancel requires at least one job id.");
				}
				const outcomes = await jobManager.cancel(ids, signal);
				const text = outcomes.map((outcome) => `- [${outcome.id}] ${outcome.status}`).join("\n");
				return {
					content: [{ type: "text", text: `Cancel results:\n${text}` }],
					details: { op: "cancel", outcomes },
				};
			}

			if (op === "list") {
				const jobs = await jobManager.list(signal);
				if (jobs.length === 0) {
					return {
						content: [{ type: "text", text: "No background jobs." }],
						details: { op: "list", jobs },
					};
				}
				return {
					content: [{ type: "text", text: jobs.map(formatJobLine).join("\n") }],
					details: { op: "list", jobs },
				};
			}

			// poll
			const jobs = await jobManager.poll(ids, signal);
			if (jobs.length === 0) {
				return {
					content: [{ type: "text", text: "No matching running jobs to wait for." }],
					details: { op: "poll", jobs },
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
				parts.push(
					"Finish independent work, then end the turn; completion wakes the channel that started each job. Do not loop on poll.",
				);
			}
			return {
				content: [{ type: "text", text: parts.join("\n\n") }],
				details: { op: "poll", jobs },
			};
		},
	};
}
