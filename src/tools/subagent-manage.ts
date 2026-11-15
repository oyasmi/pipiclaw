import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SecurityConfig } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { type SubAgentDiscoveryResult, validateSubAgentTask } from "../subagents/discovery.js";
import { dispatchExternalFollowUp } from "../subagents/external/dispatch.js";
import { readLastOutputAt, STALL_THRESHOLD_MS } from "../subagents/external/progress-tail.js";
import { formatCost, formatRunDuration, harnessLabel } from "../subagents/format.js";
import type { RunRecord } from "../subagents/run-record.js";
import type { SubAgentRunManager } from "../subagents/runs.js";

// Spec 047, P3: `subagent_list` is zero-argument and shape-independent (like `task_list`); the
// other three ops all take `runId`, so they stay together in `subagent_run` rather than being
// split per-verb (`cancel` and `show` have identical parameter sets).
const subagentListSchema = Type.Object({});

const subagentRunSchema = Type.Object({
	op: Type.Union([Type.Literal("show"), Type.Literal("cancel"), Type.Literal("follow_up")], {
		description: '"show" full detail for self-diagnosis, "cancel" a running one, or "follow_up" a resumable run.',
	}),
	runId: Type.String({ description: "The run id to operate on." }),
	task: Type.Optional(Type.String({ description: "New instruction. Required for op=follow_up." })),
});

export interface SubAgentManageToolOptions {
	runManager: SubAgentRunManager;
	channelId: string;
	/**
	 * Spec 042 D7: required, not defaulted. `follow_up` dispatches a new external process through
	 * the same envelope and audit path the initial dispatch uses (D9's verify task path, D8.1's
	 * audit log, D7's `buildFollowUpTask`) — all of which need the real value. The previous
	 * `options.workspaceDir ?? ""` silently pointed the audit log at the daemon's own cwd and
	 * malformed the verify task path; production has always supplied both, so making them required
	 * only tightens what was already true rather than changing production behavior.
	 */
	workspaceDir: string;
	desk: string;
	deskDir: string;
	/** Needed only for `follow_up`: re-resolves the role's current config by name. */
	getSubAgentDiscovery?: () => SubAgentDiscoveryResult;
	securityConfig?: SecurityConfig;
}

interface SubAgentRunArgs {
	op: "cancel" | "follow_up" | "show";
	runId: string;
	task?: string;
}

/** Spec 042 D9: cap on `op=list`'s output — see the call site for why running runs are exempt. */
const LIST_CAP = 50;
/** Matches `/subagents show`'s own cap (`subagents/commands.ts`) — enough to diagnose a
 *  failure without dumping an unbounded log into the model's context. */
const STDERR_TAIL_CHARS = 2_000;

/** `here` is the calling channel: a run another channel of this desk started is labelled with its origin. */
function formatRunLine(record: RunRecord, here: string): string {
	const task = record.taskId ? `, task ${record.taskId}` : "";
	const origin = record.channelId !== here ? `, started in ${record.channelId}` : "";
	const lease = record.leaseKey ? ", lease held" : "";
	const cost = formatCost(record);
	const costPart = cost ? `, ${cost}` : "";
	const header = `- [${record.runId}] ${record.agent} (${harnessLabel(record)}) — "${record.label}" — ${record.status} (${formatRunDuration(record)}${task}${lease}${costPart}${origin})`;
	if (record.status === "failed" && record.failureReason) {
		return `${header}\n  failed: ${record.failureReason}`;
	}
	return header;
}

/**
 * The machine-readable subset of `/subagents show` (`subagents/commands.ts`'s `showRun`):
 * argv, dispatch-time warnings, and the adapter/CLI version pair the model previously had no way
 * to see at all — it could only guess at a failed external run's cause or re-dispatch blindly
 * (review 2026-08-23 §3.4).
 */
async function formatRunShow(record: RunRecord): Promise<string> {
	const lines = [
		`Run ${record.runId}: ${record.agent} (${harnessLabel(record)}, ${record.source}) — ${record.status} (${formatRunDuration(record)})`,
		`purpose=${record.purpose}, workingDirectory=${record.workingDirectory}, artifactDir=${record.artifactDir}`,
	];
	if (record.failureReason) lines.push(`failureReason: ${record.failureReason}`);
	if (record.verificationVerdict) {
		lines.push(`verification: ${record.verificationVerdict.toUpperCase()}`);
	}
	if (record.taskId) lines.push(`taskId: ${record.taskId}${record.item ? ` item: ${record.item}` : ""}`);
	if (record.leaseKey) lines.push("holds write lease: yes");
	if (record.model) lines.push(`model: ${record.model}`);
	const cost = formatCost(record);
	lines.push(`usage: input=${record.usage.input} output=${record.usage.output}${cost ? ` cost=${cost}` : ""}`);
	if (record.argv) lines.push(`argv: ${JSON.stringify(record.argv)}`);
	if (record.parserVersion !== undefined || record.cliVersion) {
		const parts: string[] = [];
		if (record.parserVersion !== undefined) parts.push(`parserVersion=${record.parserVersion}`);
		parts.push(`cliVersion=${record.cliVersion ?? "(unknown)"}`);
		lines.push(`adapter/CLI: ${parts.join(", ")}`);
	}
	if (record.invocationWarnings?.length) {
		lines.push("dispatch warnings:", ...record.invocationWarnings.map((warning) => `- ${warning}`));
	}
	if (record.sessionId) lines.push(`sessionId: ${record.sessionId} (usable with subagent_run op=follow_up)`);
	if (record.runtime === "external" && record.status === "running") {
		// The one signal that tells a long, busy run apart from a stuck one without reading its logs.
		const lastOutputAt = await readLastOutputAt(record.artifactDir);
		const silentMs = Date.now() - (lastOutputAt ?? record.processStartedAt ?? record.startedAt);
		const stalled = silentMs >= STALL_THRESHOLD_MS ? " — possibly stalled; cancel if it should have progressed" : "";
		lines.push(`last output: ${Math.round(silentMs / 1000)}s ago${stalled}`);
	}
	if (record.runtime === "external") {
		const stderrTail = await readFile(join(record.artifactDir, "stderr.log"), "utf-8")
			.then((text) => text.slice(-STDERR_TAIL_CHARS))
			.catch(() => undefined);
		if (stderrTail?.trim()) lines.push("", "stderr (tail):", stderrTail);
	}
	return lines.join("\n");
}

export function createSubAgentListTool(options: SubAgentManageToolOptions): AgentTool<typeof subagentListSchema> {
	const manager = options.runManager;
	return {
		name: "subagent_list",
		label: "subagent_list",
		description:
			"Snapshot of this desk's delegation runs, shared by every channel bound to it. A run's completion wakes the " +
			'channel that started it (a run from another channel is marked "started in <channel>"); inspect when a ' +
			"decision needs current status, not in a polling loop.",
		parameters: subagentListSchema,
		execute: async () => {
			// Spec 042 D9: this used to return every run on the channel, unbounded, in both the
			// text and `details.runs` — a long-lived channel could dump thousands of historical
			// records into a single tool result. Running runs (the ones a decision might depend
			// on) are never dropped; only the terminal tail is capped, newest first.
			const allRuns = manager.list();
			const running = allRuns.filter((record) => record.status === "running");
			const terminal = allRuns
				.filter((record) => record.status !== "running")
				.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
			const shownTerminal = terminal.slice(0, Math.max(0, LIST_CAP - running.length));
			const runs = [...running, ...shownTerminal];
			const lines =
				runs.length === 0
					? ["No delegation runs."]
					: runs.map((record) => formatRunLine(record, options.channelId));
			if (runs.length < allRuns.length) {
				lines.push(
					`… showing ${runs.length} of ${allRuns.length} runs (all running + most recently finished). Ask about a specific runId if you need an older one not shown here.`,
				);
			}
			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { op: "list", runs },
			};
		},
	};
}

export function createSubAgentRunTool(options: SubAgentManageToolOptions): AgentTool<typeof subagentRunSchema> {
	const manager = options.runManager;

	return {
		name: "subagent_run",
		label: "subagent_run",
		description:
			"Operate on one delegation run by runId. show: full detail for self-diagnosis. cancel: stop a running one " +
			"(no wake — your decision, not a failure). follow_up: continue a resumable run with a new instruction (new runId).",
		parameters: subagentRunSchema,
		execute: async (_toolCallId: string, { op, runId, task }: SubAgentRunArgs) => {
			const resolution = manager.resolveRef(runId);
			if (resolution.kind === "ambiguous") {
				throw new RecoverableToolError(
					`"${runId}" matches multiple runs in this desk: ${resolution.candidates.map((candidate) => candidate.runId).join(", ")}. Use the full runId.`,
				);
			}
			if (resolution.kind === "not_found") {
				throw new RecoverableToolError(`Run "${runId}" was not found in this desk.`);
			}
			const resolvedRunId = resolution.record.runId;

			if (op === "show") {
				const text = await formatRunShow(resolution.record);
				return {
					content: [{ type: "text", text }],
					details: { op, runId: resolvedRunId },
				};
			}

			if (op === "cancel") {
				const status = await manager.cancel(resolvedRunId);
				return {
					content: [{ type: "text", text: `Cancel requested for run ${resolvedRunId}: ${status}` }],
					details: { op, runId: resolvedRunId, status },
				};
			}

			// follow_up: validate parameters in the adapter, then delegate domain orchestration.
			if (!task || !task.trim()) {
				throw new RecoverableToolError("follow_up requires task.");
			}
			const taskLengthError = validateSubAgentTask(task);
			if (taskLengthError) {
				throw new RecoverableToolError(taskLengthError);
			}
			const { newRunId } = await dispatchExternalFollowUp({
				runManager: manager,
				record: resolution.record,
				task,
				channelId: options.channelId,
				workspaceDir: options.workspaceDir,
				desk: options.desk,
				deskDir: options.deskDir,
				discovery: options.getSubAgentDiscovery?.(),
				securityConfig: options.securityConfig,
			});

			return {
				content: [
					{
						type: "text",
						text: `Follow-up dispatched as runId=${newRunId} (resuming ${resolvedRunId}). Whoever dispatched it (this chat, or the task whose step did) will be woken when it finishes.`,
					},
				],
				details: { op, runId: newRunId, resumedFrom: resolvedRunId },
			};
		},
	};
}
