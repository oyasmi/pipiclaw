/**
 * The `runtime: external` half of delegation dispatch: launches the harness process through
 * `external/run.ts`. Always returns the "[Dispatched]" placeholder.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_SECURITY_CONFIG } from "../../security/config.js";
import { RecoverableToolError } from "../../shared/recoverable-error.js";
import { createEmptyUsageTotals } from "../../usage/totals.js";
import { type ExternalSubAgentConfig, externalRoleFingerprint } from "../discovery.js";
import { buildDispatchedText, createDetails } from "../result.js";
import type { SubAgentRunManager } from "../runs.js";
import { buildSubAgentTask, resolveContextualBlocks } from "../task-envelope.js";
import type { DelegationParams, DelegationResult, SubAgentRunContext, SubAgentToolOptions } from "../types.js";
import { releaseWorkspaceLease } from "../workspace-lease.js";
import type { WorkspaceBaseline } from "../workspace-summary.js";
import { type ExternalLaunchResult, launchExternalRun } from "./run.js";

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
	// Spec 042 D2: a pre-spawn failure is reported in this same turn instead of a
	// "[Dispatched]" placeholder the model would wait on forever — two of the three
	// failure kinds never used to announce at all. `settle()` already released the lease.
	if (!launchResult.ok) {
		if (launchResult.kind === "missing-binary") {
			throw new Error(
				`Sub-agent "${config.name}" failed to launch: ${launchResult.reason} Install the CLI or fix "command" in its role file; the run was not dispatched.`,
			);
		}
		throw new RecoverableToolError(
			`Sub-agent "${config.name}" failed to launch: ${launchResult.reason} The run was not dispatched.`,
		);
	}
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
