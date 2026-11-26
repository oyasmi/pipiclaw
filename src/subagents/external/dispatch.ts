/**
 * The `runtime: external` half of delegation dispatch and `follow_up` continuation: launches the
 * harness process through `external/run.ts` and converts pre-spawn launch failures into tool errors.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_SECURITY_CONFIG } from "../../security/config.js";
import type { SecurityConfig } from "../../security/types.js";
import { RecoverableToolError } from "../../shared/recoverable-error.js";
import { createEmptyUsageTotals } from "../../usage/totals.js";
import { externalRoleFingerprint } from "../discovery.js";
import { buildDispatchedText, createDetails } from "../result.js";
import type { RunRecord } from "../run-record.js";
import type { SubAgentRunManager } from "../runs.js";
import {
	assertVerifyAdmissible,
	buildFollowUpTask,
	buildSubAgentTask,
	resolveContextualBlocks,
} from "../task-envelope.js";
import type {
	DelegationParams,
	DelegationResult,
	ExternalSubAgentConfig,
	SubAgentDiscoveryResult,
	SubAgentRunContext,
	SubAgentToolOptions,
} from "../types.js";
import { acquireWorkspaceLease, formatWorkspaceLeaseConflict, releaseWorkspaceLease } from "../workspace-lease.js";
import { snapshotWorkspace, type WorkspaceBaseline } from "../workspace-summary.js";
import { copyManagedWorktreeMeta } from "../worktree.js";
import { blocksExternalFollowUp, formatFailureGuidance } from "./failure-classify.js";
import { getExternalHarness } from "./registry.js";
import { type ExternalLaunchResult, launchExternalRun } from "./run.js";

/**
 * Spec 042 D2: a pre-spawn failure is reported in the dispatching turn instead of returning a
 * "[Dispatched]" placeholder the model would wait on forever. `settle()` already released any lease.
 */
function throwOnExternalLaunchFailure(
	launchResult: ExternalLaunchResult,
	subjectLabel: string,
	targetNoun: "run" | "follow-up",
): void {
	if (launchResult.ok) return;
	if (launchResult.kind === "missing-binary") {
		throw new Error(
			`${subjectLabel} failed to launch: ${launchResult.reason} Install the CLI or fix "command" in its role file; the ${targetNoun} was not dispatched.`,
		);
	}
	throw new RecoverableToolError(
		`${subjectLabel} failed to launch: ${launchResult.reason} The ${targetNoun} was not dispatched.`,
	);
}

/**
 * The `runtime: external` half of `dispatchSubAgentRun` (spec 046, D2.5): launches the harness
 * process and always returns the "[Dispatched]" placeholder — external's sync grace window is
 * always 0, so there is no inline-wait branch to share with the internal path.
 */
export async function dispatchExternalRun(input: {
	runManager: SubAgentRunManager;
	options: SubAgentToolOptions;
	currentModel: Model<Api>;
	config: ExternalSubAgentConfig;
	runLabel: string;
	runContext: SubAgentRunContext;
	leaseKey: string | undefined;
	params: DelegationParams;
	workspaceBaseline: WorkspaceBaseline | undefined;
}): Promise<DelegationResult> {
	const { options, config, runLabel, runContext, leaseKey, params } = input;
	let launchResult: ExternalLaunchResult;
	try {
		// D9/T5: external roles get the same task envelope internal workers do — runtime
		// paths, injected context blocks, and (for purpose=verify) the verification
		// protocol — rather than the raw task text (spec 040 gap closed post-review).
		const contextualBlocks = await resolveContextualBlocks(config, options);
		const envelopedTask = buildSubAgentTask(
			params.task,
			config,
			options.runtimeContext,
			contextualBlocks,
			runContext,
		);
		launchResult = await launchExternalRun({
			runManager: input.runManager,
			runId: runContext.runId,
			channelId: options.runtimeContext.channelId,
			deskDir: options.deskDir,
			label: runLabel,
			agent: config.name,
			source: config.source,
			harness: config.harness,
			command: config.command,
			shell: config.shell,
			env: config.env,
			externalModelRef: config.externalModelRef,
			thinkingLevel: config.thinkingLevel,
			maxWallTimeSec: config.maxWallTimeSec,
			systemPrompt: config.systemPrompt,
			task: envelopedTask,
			workingDirectory: runContext.workingDirectory,
			artifactDir: runContext.artifactDir,
			purpose: runContext.purpose,
			taskId: runContext.taskId,
			taskDigest: runContext.taskDigest,
			item: runContext.item,
			leaseKey,
			mutates: config.mutates,
			workspaceBaseline: input.workspaceBaseline,
			roleFingerprint: externalRoleFingerprint(config),
			workspaceDir: options.workspaceDir,
			securityConfig: options.securityConfig ?? DEFAULT_SECURITY_CONFIG,
		});
	} catch (error) {
		// Only a pre-register() throw (unknown harness, shell-mode misuse) reaches here —
		// every failure past that point settles the run itself and already released this
		// lease (spec 042 D2/D5), so this catch must not release it a second time.
		releaseWorkspaceLease(leaseKey, runContext.runId);
		throw error;
	}
	throwOnExternalLaunchFailure(launchResult, `Sub-agent "${config.name}"`, "run");
	// D2: external's sync grace window is always 0 — always the dispatched placeholder,
	// never an inline wait. The run keeps going in the background and wakes the channel.
	return {
		content: [
			{
				type: "text",
				text: buildDispatchedText(
					runContext.runId,
					config.name,
					`external, ${config.harness}`,
					runContext.workingDirectory,
					runContext.managedWorktree,
				),
			},
		],
		details: createDetails({
			config,
			runContext,
			usage: createEmptyUsageTotals(),
			turns: 0,
			toolCalls: 0,
			durationMs: 0,
			dispatched: true,
			modelOverride: config.externalModelRef ?? "unknown",
			toolsOverride: [],
		}),
	};
}

/**
 * Resumes a finished external run on a resumable harness under a fresh `runId`, re-validating role
 * availability, harness identity, verify admissibility, role fingerprint, and workspace leases.
 */
export async function dispatchExternalFollowUp(input: {
	runManager: SubAgentRunManager;
	record: RunRecord;
	task: string;
	channelId: string;
	workspaceDir: string;
	desk: string;
	deskDir: string;
	discovery?: SubAgentDiscoveryResult;
	securityConfig?: SecurityConfig;
}): Promise<{ newRunId: string }> {
	const { runManager, record, task } = input;
	const resolvedRunId = record.runId;
	const harness =
		record.runtime === "external" && record.harness && getExternalHarness(record.harness)?.resumable
			? record.harness
			: undefined;
	if (!harness) {
		// Internal runs have no persisted transcript to resume — the isolated-context design
		// is the point, not a gap. Non-resumable harnesses (`exec`) have no session concept.
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
	if (record.failureKind && blocksExternalFollowUp(record.failureKind)) {
		const guidance =
			record.failureKind === "resume_rejected"
				? formatFailureGuidance(record.failureKind)
				: "Ask the user to resolve the account, quota, or model configuration issue before starting a fresh delegation.";
		throw new RecoverableToolError(`Run "${resolvedRunId}" cannot be resumed (${record.failureKind}). ${guidance}`);
	}
	const role = input.discovery?.agents.find(
		(agent): agent is ExternalSubAgentConfig => agent.name === record.agent && agent.runtime === "external",
	);
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
	if (!existsSync(record.workingDirectory)) {
		throw new RecoverableToolError(
			`Run "${resolvedRunId}"'s working directory "${record.workingDirectory}" no longer exists (for example, an unchanged managed worktree was cleaned up on settlement). Delegate a new run instead.`,
		);
	}

	assertVerifyAdmissible(role, record.purpose, record.workingDirectory);

	// Spec 042 D7: a role hot-edited since the original dispatch (different command, model,
	// or shell mode) would resume the old session under a harness invocation it never wrote.
	const currentFingerprint = externalRoleFingerprint(role);
	if (record.roleFingerprint !== undefined && record.roleFingerprint !== currentFingerprint) {
		throw new RecoverableToolError(
			`Role "${record.agent}" has changed (command, model, or shell mode) since run "${resolvedRunId}" was dispatched; resuming under the new config could reinterpret the old session incorrectly. Delegate a new run instead.`,
		);
	}

	const newRunId = runManager.mintRunId();

	const lease = acquireWorkspaceLease({
		runId: newRunId,
		channelId: input.channelId,
		workingDirectory: record.workingDirectory,
		mode: role.mutates === "write" ? "write" : record.purpose === "verify" ? "read" : "use",
	});
	if (!lease.ok) throw new RecoverableToolError(formatWorkspaceLeaseConflict(lease.heldBy));
	const leaseKey = lease.leaseKey;

	// Spec 042 D7: `<subagent-artifacts>/<runId>` computed with path join rather than regex substitution.
	const artifactDir = join(dirname(record.artifactDir), newRunId);
	const runContext: SubAgentRunContext = {
		runId: newRunId,
		purpose: record.purpose,
		taskId: record.taskId,
		item: record.item,
		workingDirectory: record.workingDirectory,
		artifactDir,
	};

	let launchResult: ExternalLaunchResult;
	try {
		// Cleanup may have won admission since the earlier preflight. Recheck while pinned.
		if (!existsSync(record.workingDirectory)) {
			throw new RecoverableToolError(
				`Run "${resolvedRunId}"'s working directory was removed; delegate a new run instead.`,
			);
		}
		await copyManagedWorktreeMeta(record.artifactDir, artifactDir).catch(() => false);
		const envelopedTask = buildFollowUpTask(
			task,
			{
				workspaceDir: input.workspaceDir,
				desk: input.desk,
				deskDir: input.deskDir,
				channelId: input.channelId,
			},
			runContext,
		);
		const workspaceBaseline = role.mutates === "write" ? await snapshotWorkspace(record.workingDirectory) : undefined;
		launchResult = await launchExternalRun({
			runManager,
			runId: newRunId,
			channelId: input.channelId,
			deskDir: input.deskDir,
			label: `follow-up: ${task.slice(0, 80)}`,
			agent: role.name,
			source: role.source,
			harness,
			command: role.command,
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
			item: record.item,
			leaseKey,
			resumeSessionId: record.sessionId,
			mutates: role.mutates,
			workspaceBaseline,
			roleFingerprint: currentFingerprint,
			workspaceDir: input.workspaceDir,
			securityConfig: input.securityConfig ?? DEFAULT_SECURITY_CONFIG,
		});
	} catch (error) {
		releaseWorkspaceLease(leaseKey, newRunId);
		throw error;
	}
	throwOnExternalLaunchFailure(launchResult, `Follow-up on run "${resolvedRunId}"`, "follow-up");
	return { newRunId };
}
