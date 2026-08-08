import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import type { SecurityConfig } from "../security/types.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import type { SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { launchExternalRun } from "../subagents/external/run.js";
import { elapsedMs, formatCost, formatDuration, harnessLabel } from "../subagents/format.js";
import { getSubAgentRunManager, type RunRecord } from "../subagents/runs.js";
import {
	acquireWorkspaceLease,
	formatWorkspaceLeaseConflict,
	releaseWorkspaceLease,
} from "../subagents/workspace-lease.js";

const subagentManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're checking (shown to user)" }),
	op: Type.Union([Type.Literal("list"), Type.Literal("cancel"), Type.Literal("follow_up")], {
		description:
			'"list" a snapshot of this channel\'s delegation runs, "cancel" a running one by runId, or ' +
			'"follow_up" to continue a resumable run with a new instruction (produces a new runId).',
	}),
	runId: Type.Optional(Type.String({ description: "Required for cancel and follow_up." })),
	task: Type.Optional(Type.String({ description: "Follow-up instruction. Required for op=follow_up." })),
});

export interface SubAgentManageToolOptions {
	channelId: string;
	/** Needed only for `follow_up` on a `purpose=verify` run: where the attestation is written. */
	channelDir?: string;
	/** Needed only for `follow_up`: re-resolves the role's current config by name. */
	getSubAgentDiscovery?: () => SubAgentDiscoveryResult;
	/** Needed only for `follow_up`, which dispatches a new external process and must audit it
	 *  exactly like the initial dispatch (D8.1/T5). */
	workspaceDir?: string;
	securityConfig?: SecurityConfig;
}

interface SubAgentManageArgs {
	op: "list" | "cancel" | "follow_up";
	runId?: string;
	task?: string;
}

function formatRunLine(record: RunRecord): string {
	const task = record.taskId ? `, task ${record.taskId}` : "";
	const lease = record.leaseKey ? ", lease held" : "";
	const cost = formatCost(record);
	const costPart = cost ? `, ${cost}` : "";
	const header = `- [${record.runId}] ${record.agent} (${harnessLabel(record)}) — "${record.label}" — ${record.status} (${formatDuration(elapsedMs(record))}${task}${lease}${costPart})`;
	if (record.status === "failed" && record.failureReason) {
		return `${header}\n  failed: ${record.failureReason}`;
	}
	return header;
}

/** Resumable harnesses only: `claude-code`/`codex-cli`. `exec` has no session concept, and internal
 *  runs have no persisted transcript by design (spec 040, non-goals). */
function resumableHarnessOf(record: RunRecord): "codex-cli" | "claude-code" | undefined {
	if (record.runtime !== "external") return undefined;
	return record.harness === "codex-cli" || record.harness === "claude-code" ? record.harness : undefined;
}

export function createSubAgentManageTool(options: SubAgentManageToolOptions): AgentTool<typeof subagentManageSchema> {
	const manager = () => getSubAgentRunManager(options.channelId);

	return {
		name: "subagent_manage",
		label: "subagent_manage",
		description:
			"Inspect and control delegation runs (internal sub-agents and, once configured, external agents): " +
			"op=list shows a snapshot of this channel's runs; op=cancel stops a running one by runId without " +
			"waking the channel (that is your own decision, not a failure); op=follow_up continues a resumable " +
			"run with a new instruction, producing a new runId. A run finishing wakes this channel by itself, " +
			"so never poll here waiting for one — end the turn instead.",
		parameters: subagentManageSchema,
		execute: async (_toolCallId: string, { op, runId, task }: SubAgentManageArgs) => {
			if (op === "list") {
				const runs = manager().list();
				const text = runs.length === 0 ? "No delegation runs." : runs.map(formatRunLine).join("\n");
				return { content: [{ type: "text", text }], details: { kind: "subagent_manage", op, runs } };
			}

			if (!runId) {
				throw new RecoverableToolError(`${op} requires runId.`);
			}
			const resolution = manager().resolveRef(runId);
			if (resolution.kind === "ambiguous") {
				throw new RecoverableToolError(
					`"${runId}" matches multiple runs on this channel: ${resolution.candidates.map((candidate) => candidate.runId).join(", ")}. Use the full runId.`,
				);
			}
			if (resolution.kind === "not_found") {
				throw new RecoverableToolError(`Run "${runId}" was not found on this channel.`);
			}
			const resolvedRunId = resolution.record.runId;

			if (op === "cancel") {
				const status = await manager().cancel(resolvedRunId);
				return {
					content: [{ type: "text", text: `Cancel requested for run ${resolvedRunId}: ${status}` }],
					details: { kind: "subagent_manage", op, runId: resolvedRunId, status },
				};
			}

			// follow_up
			if (!task || !task.trim()) {
				throw new RecoverableToolError("follow_up requires task.");
			}
			const record = resolution.record;
			const harness = resumableHarnessOf(record);
			if (!harness) {
				// Internal runs have no persisted transcript to resume — the isolated-context design
				// is the point, not a gap. `exec` has no session concept at all. Directing the model
				// at a fresh delegation, not a fallback to "just use internal", keeps this honest (P2).
				throw new RecoverableToolError(
					`Run "${resolvedRunId}" (${record.runtime}${record.harness ? `/${record.harness}` : ""}) does not support ` +
						"follow_up yet. Delegate a new run instead, carrying forward whatever context or prior output it needs.",
				);
			}
			if (record.status === "running") {
				throw new RecoverableToolError(
					`Run "${resolvedRunId}" is still running; wait for it to finish before following up.`,
				);
			}
			if (!record.sessionId) {
				throw new RecoverableToolError(
					`Run "${resolvedRunId}" never reported a session id (it likely failed before producing one); it cannot be resumed. Delegate a new run instead.`,
				);
			}
			const discovery = options.getSubAgentDiscovery?.();
			const role = discovery?.agents.find((agent) => agent.name === record.agent && agent.runtime === "external");
			if (!role) {
				throw new RecoverableToolError(
					`Role "${record.agent}" is no longer configured as an external role; cannot follow up run "${resolvedRunId}".`,
				);
			}
			if (role.unavailable) {
				throw new RecoverableToolError(`Role "${record.agent}" is currently unavailable: ${role.unavailable}`);
			}

			// A short, human-typeable id (spec 041) — the follow-up gets a fresh identity, not the
			// dispatching tool call's own id.
			const newRunId = manager().mintRunId();

			let leaseKey: string | undefined;
			if (role.mutates === "write") {
				const lease = acquireWorkspaceLease({
					runId: newRunId,
					channelId: options.channelId,
					workingDirectory: record.workingDirectory,
				});
				if (!lease.ok) {
					throw new RecoverableToolError(formatWorkspaceLeaseConflict(lease.heldBy));
				}
				leaseKey = lease.leaseKey;
			}

			try {
				await launchExternalRun({
					runId: newRunId,
					channelId: options.channelId,
					channelDir: options.channelDir,
					label: `follow-up: ${task.slice(0, 80)}`,
					agent: role.name,
					source: role.source,
					harness,
					command: role.command ?? "",
					shell: role.shell,
					env: role.env,
					externalModelRef: role.externalModelRef,
					thinkingLevel: role.thinkingLevel,
					maxWallTimeSec: role.maxWallTimeSec,
					systemPrompt: role.systemPrompt,
					task,
					workingDirectory: record.workingDirectory,
					artifactDir: record.artifactDir.replace(/[^/\\]+$/, newRunId),
					purpose: record.purpose,
					taskId: record.taskId,
					leaseKey,
					resumeSessionId: record.sessionId,
					mutates: role.mutates,
					workspaceDir: options.workspaceDir ?? "",
					securityConfig: options.securityConfig ?? DEFAULT_SECURITY_CONFIG,
				});
			} catch (error) {
				// Until launchExternalRun has durably registered the run, no settlement authority owns
				// this lease. Releasing here mirrors the initial subagent dispatch path and covers prompt,
				// artifact, audit, invocation, and pre-spawn failures in follow_up.
				releaseWorkspaceLease(leaseKey);
				throw error;
			}

			return {
				content: [
					{
						type: "text",
						text: `Follow-up dispatched as runId=${newRunId} (resuming ${resolvedRunId}). This channel will be woken when it finishes.`,
					},
				],
				details: { kind: "subagent_manage", op, runId: newRunId, resumedFrom: resolvedRunId },
			};
		},
	};
}
