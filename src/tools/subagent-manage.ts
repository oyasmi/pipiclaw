import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { MemoryCandidateStore } from "../memory/candidates.js";
import { DEFAULT_SECURITY_CONFIG } from "../security/config.js";
import type { SecurityConfig } from "../security/types.js";
import type { PipiclawMemoryRecallSettings } from "../settings.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { externalRoleFingerprint, type SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { type ExternalLaunchResult, launchExternalRun } from "../subagents/external/run.js";
import { formatCost, formatRunDuration, harnessLabel } from "../subagents/format.js";
import { getSubAgentRunManager, type RunRecord } from "../subagents/runs.js";
import {
	assertVerifyAdmissible,
	buildContextualBlocks,
	buildSubAgentTask,
	type SubAgentRunContext,
} from "../subagents/tool.js";
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
	/**
	 * Spec 042 D7: required, not defaulted. `follow_up` dispatches a new external process through
	 * the same envelope and audit path the initial dispatch uses (D9's verify task path, D8.1's
	 * audit log, D7's `buildSubAgentTask`) — all of which need the real value. The previous
	 * `options.workspaceDir ?? ""` silently pointed the audit log at the daemon's own cwd and
	 * malformed the verify task path; production has always supplied both, so making them required
	 * only tightens what was already true rather than changing production behavior.
	 */
	workspaceDir: string;
	channelDir: string;
	/** Needed only for `follow_up`: re-resolves the role's current config by name. */
	getSubAgentDiscovery?: () => SubAgentDiscoveryResult;
	securityConfig?: SecurityConfig;
	/** Spec 042 D7: `follow_up` builds its envelope through the same `buildContextualBlocks` the
	 *  initial dispatch uses — these three are what that function needs beyond `channelDir`/`workspaceDir`. */
	getCurrentModel?: () => Model<Api>;
	resolveApiKey?: (model: Model<Api>) => Promise<string>;
	getMemoryRecallSettings?: () => PipiclawMemoryRecallSettings;
	memoryCandidateStore?: MemoryCandidateStore;
}

interface SubAgentManageArgs {
	op: "list" | "cancel" | "follow_up";
	runId?: string;
	task?: string;
}

/** Spec 042 D9: cap on `op=list`'s output — see the call site for why running runs are exempt. */
const LIST_CAP = 50;

function formatRunLine(record: RunRecord): string {
	const task = record.taskId ? `, task ${record.taskId}` : "";
	const lease = record.leaseKey ? ", lease held" : "";
	const cost = formatCost(record);
	const costPart = cost ? `, ${cost}` : "";
	const header = `- [${record.runId}] ${record.agent} (${harnessLabel(record)}) — "${record.label}" — ${record.status} (${formatRunDuration(record)}${task}${lease}${costPart})`;
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
				// Spec 042 D9: this used to return every run on the channel, unbounded, in both the
				// text and `details.runs` — a long-lived channel could dump thousands of historical
				// records into a single tool result. Running runs (the ones a decision might depend
				// on) are never dropped; only the terminal tail is capped, newest first.
				const allRuns = manager().list();
				const running = allRuns.filter((record) => record.status === "running");
				const terminal = allRuns
					.filter((record) => record.status !== "running")
					.sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
				const shownTerminal = terminal.slice(0, Math.max(0, LIST_CAP - running.length));
				const runs = [...running, ...shownTerminal];
				const lines = runs.length === 0 ? ["No delegation runs."] : runs.map(formatRunLine);
				if (runs.length < allRuns.length) {
					lines.push(
						`… showing ${runs.length} of ${allRuns.length} runs (all running + most recently finished). Ask about a specific runId if you need an older one not shown here.`,
					);
				}
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { op, runs },
				};
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
					details: { op, runId: resolvedRunId, status },
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
			// P1-2: a role hot-edited between the original run and this follow-up must not silently
			// resume under a stale harness (the wrong CLI would parse a command it never wrote), or
			// masquerade a shell role as resumable (there is no flag to carry `resumeSessionId` into
			// `/bin/sh -lc`, so the run would silently start a fresh, unrelated session anyway).
			if (role.harness !== harness) {
				throw new RecoverableToolError(
					`Role "${record.agent}" now uses harness "${role.harness}", but run "${resolvedRunId}" was started on "${harness}". Delegate a new run instead of resuming across a harness change.`,
				);
			}
			if (role.shell) {
				throw new RecoverableToolError(
					`Role "${record.agent}" runs its command through a shell, which has no way to carry a resume session id. Delegate a new run instead, carrying forward whatever context it needs.`,
				);
			}

			// Spec 042 D7: verify admission is re-checked against the *current* role config, shared
			// with the initial dispatch — a role hot-edited to mutates: write since the original run
			// must not silently take the write lease and dispatch just because it once was read-only.
			assertVerifyAdmissible(role, record.purpose, record.workingDirectory);

			// Spec 042 D7: a role hot-edited since the original dispatch (different command, model,
			// or shell mode) would resume the old session under a harness invocation it never wrote.
			// Only enforced when the original run actually recorded a fingerprint — an older record
			// predating this field cannot be checked, so it is let through rather than made
			// permanently unresumable.
			const currentFingerprint = externalRoleFingerprint(role);
			if (record.roleFingerprint !== undefined && record.roleFingerprint !== currentFingerprint) {
				throw new RecoverableToolError(
					`Role "${record.agent}" has changed (command, model, or shell mode) since run "${resolvedRunId}" was dispatched; resuming under the new config could reinterpret the old session incorrectly. Delegate a new run instead.`,
				);
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

			// Spec 042 D7: the same `<subagent-artifacts>/<runId>` layout the initial dispatch uses,
			// computed with a real path join rather than a regex substitution that assumed the old
			// runId was the last path segment with no separators of its own.
			const artifactDir = join(dirname(record.artifactDir), newRunId);
			const runContext: SubAgentRunContext = {
				runId: newRunId,
				purpose: record.purpose,
				taskId: record.taskId,
				workingDirectory: record.workingDirectory,
				artifactDir,
			};

			// Spec 042 D7: the same envelope construction the initial dispatch uses — runtime context
			// (including this run's own artifact directory), paths/session/memory context blocks, and
			// (for a verify run) the verification protocol — not a hand-rolled "task + maybe verify
			// protocol" that left the external agent unaware of its own working/artifact directories.
			// `getCurrentModel`/`resolveApiKey` are only needed for the `memory: relevant` recall path
			// inside `buildContextualBlocks` — optional here so a caller that only ever exercises
			// list/cancel is not forced to wire an LLM-backed dependency it will never use. Absent
			// either, context blocks degrade to none rather than guessing at a model or key.
			const contextualBlocks =
				options.getCurrentModel && options.resolveApiKey
					? await buildContextualBlocks(
							task,
							role,
							{
								channelDir: options.channelDir,
								workspaceDir: options.workspaceDir,
								runtimeContext: { workspaceDir: options.workspaceDir, channelId: options.channelId },
								getMemoryRecallSettings: options.getMemoryRecallSettings,
								resolveApiKey: options.resolveApiKey,
								memoryCandidateStore: options.memoryCandidateStore,
							},
							options.getCurrentModel(),
						)
					: [];
			const envelopedTask = buildSubAgentTask(
				task,
				role,
				{ workspaceDir: options.workspaceDir, channelId: options.channelId },
				contextualBlocks,
				runContext,
				// returns: "artifact" has no external equivalent (spec 042 D3) and follow_up never
				// requests it — always "text", matching the initial external dispatch.
				"text",
			);

			let launchResult: ExternalLaunchResult;
			try {
				launchResult = await launchExternalRun({
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
					task: envelopedTask,
					workingDirectory: record.workingDirectory,
					artifactDir,
					purpose: record.purpose,
					taskId: record.taskId,
					leaseKey,
					resumeSessionId: record.sessionId,
					mutates: role.mutates,
					roleFingerprint: currentFingerprint,
					workspaceDir: options.workspaceDir,
					securityConfig: options.securityConfig ?? DEFAULT_SECURITY_CONFIG,
				});
			} catch (error) {
				// Until launchExternalRun has durably registered the run, no settlement authority owns
				// this lease. Releasing here mirrors the initial subagent dispatch path and covers prompt,
				// artifact, audit, invocation, and pre-spawn failures in follow_up.
				releaseWorkspaceLease(leaseKey, newRunId);
				throw error;
			}
			// Spec 042 D2: a pre-spawn failure is reported in this same turn — settle() already
			// released the lease, so there is nothing left to clean up here.
			if (!launchResult.ok) {
				if (launchResult.kind === "missing-binary") {
					throw new Error(
						`Follow-up on run "${resolvedRunId}" failed to launch: ${launchResult.reason} Install the CLI or fix "command" in its role file; the follow-up was not dispatched.`,
					);
				}
				throw new RecoverableToolError(
					`Follow-up on run "${resolvedRunId}" failed to launch: ${launchResult.reason} The follow-up was not dispatched.`,
				);
			}

			return {
				content: [
					{
						type: "text",
						text: `Follow-up dispatched as runId=${newRunId} (resuming ${resolvedRunId}). This channel will be woken when it finishes.`,
					},
				],
				details: { op, runId: newRunId, resumedFrom: resolvedRunId },
			};
		},
	};
}
