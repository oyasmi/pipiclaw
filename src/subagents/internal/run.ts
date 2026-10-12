/**
 * The `runtime: internal` half of delegation dispatch (spec 046 D2.5): register the durable run
 * record, start the worker, drive it to completion (with the D6 convergence turn), settle it, and
 * return either its real result or — once the sync grace window elapses — a "[Dispatched]"
 * placeholder while the run keeps going in the background.
 *
 * Orchestration only: the worker, provider retry and outcome assembly live in their own files. The
 * lease release on every pre-registration failure, the cancel handle installed before any setup I/O,
 * and the grace/detach split all stay here, in this order.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import * as log from "../../log.js";
import { formatModelReference } from "../../models/utils.js";
import { errorMessage } from "../../shared/text-utils.js";
import { sleepUnref } from "../../shared/with-timeout.js";
import type { ResolvedInternalSubAgentConfig } from "../discovery.js";
import { graceDeadlineFor, watchAbort } from "../grace.js";
import { buildDispatchedText, createDetails, formatStatus } from "../result.js";
import { resolveSyncGraceMs, type SubAgentRunManager } from "../runs.js";
import { buildSubAgentTask, resolveContextualBlocks } from "../task-envelope.js";
import type {
	DelegationParams,
	DelegationResult,
	SubAgentRunContext,
	SubAgentToolOptions,
	SubAgentWorker,
} from "../types.js";
import { releaseWorkspaceLease } from "../workspace-lease.js";
import type { WorkspaceBaseline } from "../workspace-summary.js";
import { buildInternalOutcome, fatalSettleInput } from "./outcome.js";
import { recoverFromProviderErrors } from "./provider-retry.js";
import { createInternalRunState, createUpdateEmitter, type InternalRunState } from "./state.js";
import { DirectoryExecutor, startWorker, type WorkerHandle } from "./worker.js";

/**
 * Spec 032 D6: when a turn/tool/wall-time budget is hit, the sub-agent gets one more,
 * tool-free turn to summarize what it already found instead of having its work discarded.
 * This is a hard stop on that convergence turn itself, independent of maxWallTimeSec.
 */
const CONVERGENCE_WALL_CLOCK_MS = 60_000;

const CONVERGENCE_PROMPT =
	"Your turn/tool-call/wall-time budget for this task is exhausted. Based only on the work you have already completed, respond now with your conclusions: confirmed facts, what remains unfinished, and suggested next steps. Do not call any more tools.";

interface InternalRunInput {
	options: SubAgentToolOptions;
	currentModel: Model<Api>;
	config: ResolvedInternalSubAgentConfig;
	runLabel: string;
	mutatesNote: string;
	runContext: SubAgentRunContext;
	leaseKey: string | undefined;
	params: DelegationParams;
	signal: AbortSignal | undefined;
	onUpdate?: (update: DelegationResult) => void;
	runManager: SubAgentRunManager;
	workspaceBaseline: WorkspaceBaseline | undefined;
}

export async function dispatchInternalRun(input: InternalRunInput): Promise<DelegationResult> {
	const { options, config, runLabel, mutatesNote, runContext, leaseKey, params, signal, onUpdate, runManager } = input;
	const scopedExecutor = new DirectoryExecutor(options.executor, runContext.workingDirectory);
	let apiKey: string;
	try {
		apiKey = await options.resolveApiKey(config.model);
	} catch (error) {
		releaseWorkspaceLease(leaseKey, runContext.runId);
		throw error;
	}
	const state = createInternalRunState(config.model, apiKey);
	/** Wakes a retry backoff early when the run is cancelled or out of wall time. */
	const retryBackoff = new AbortController();
	const handle: WorkerHandle = {};

	try {
		await runManager.register({
			runId: runContext.runId,
			channelId: options.runtimeContext.channelId,
			runtime: "internal",
			agent: config.name,
			label: runLabel,
			source: config.source,
			tools: [...config.tools],
			model: formatModelReference(config.model),
			purpose: runContext.purpose,
			taskId: runContext.taskId,
			item: runContext.item,
			workingDirectory: runContext.workingDirectory,
			artifactDir: runContext.artifactDir,
			channelDir: options.channelDir,
			leaseKey,
			mutates: config.mutates,
			workspaceBaseline: input.workspaceBaseline,
		});
	} catch (error) {
		// Until the durable running record exists, setup still owns the lease. A channel/host
		// admission rejection or required persist failure must leave no invisible writer lock.
		releaseWorkspaceLease(leaseKey, runContext.runId);
		throw error;
	}
	// Install the cancel handle before any setup I/O (tool construction, Git snapshots, worker
	// creation) can yield. Without this provisional handle, a cancel in that window was treated as
	// an unreachable run: the manager released the lease and settled it while the worker could still
	// start writing after the supposed cancellation (especially dangerous for a write verifier).
	runManager.registerCancelHandle(runContext.runId, () => {
		state.externallyCancelled = true;
		retryBackoff.abort();
		handle.worker?.abort();
	});

	const emitUpdate = createUpdateEmitter({ config, runContext, state, onUpdate });
	try {
		startWorker({ handle, options, config, runContext, scopedExecutor, state, retryBackoff, runManager, emitUpdate });
	} catch (error) {
		await failSetup(error, handle, state, runManager, runContext);
	}
	const worker = handle.worker!;
	const unsubscribe = handle.unsubscribe!;
	const wallClockTimer = handle.wallClockTimer!;

	// D2: the tool call waits at most until this turn's shared grace deadline (never longer than
	// the run's own wall clock budget) before degrading to a "still running" placeholder. It also
	// stops waiting the moment the turn is aborted (`/stop`): the SDK awaits this call, so ignoring
	// the signal held `/stop` until its force-end fallback — and a result that then arrived inside
	// the grace window settled `announce: false` into a turn that no longer existed, so nobody
	// ever saw it. The run itself keeps executing either way — only the *return* differs.
	const now = Date.now();
	const deadline = Math.min(
		graceDeadlineFor(signal, resolveSyncGraceMs(options.syncGraceMs), now),
		now + config.maxWallTimeSec * 1000,
	);
	const outcomePromise = runToCompletion({
		options,
		config,
		runContext,
		params,
		state,
		retryBackoff,
		emitUpdate,
		worker,
		unsubscribe,
		wallClockTimer,
		mutatesNote,
		workspaceBaseline: input.workspaceBaseline,
	}).then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({
			ok: false as const,
			error: error instanceof Error ? error : new Error(String(error)),
		}),
	);

	const abortWatch = watchAbort(signal);
	const raceResult = await Promise.race([
		outcomePromise,
		sleepUnref(Math.max(0, deadline - now)).then(() => "timed-out" as const),
		abortWatch.aborted,
	]);
	abortWatch.dispose();

	if (raceResult !== "timed-out" && raceResult !== "aborted") {
		runManager.clearCancelHandle(runContext.runId);
		if (!raceResult.ok) {
			await runManager.settle(runContext.runId, fatalSettleInput(state, raceResult.error), { announce: false });
			throw raceResult.error;
		}
		await runManager.settle(runContext.runId, raceResult.value.settleInput, { announce: false });
		return raceResult.value.toolResult;
	}

	// Grace window elapsed (or the turn was stopped): hand back a placeholder now and let the run
	// keep going in the background. It settles and, this time, announces itself with a completion
	// wake (D2/D7) — the same "runtime guarantees completion" contract background jobs already keep.
	state.detached = true;
	void outcomePromise.then(async (outcome) => {
		runManager.clearCancelHandle(runContext.runId);
		const settleInput = outcome.ok ? outcome.value.settleInput : fatalSettleInput(state, outcome.error);
		await runManager.settle(runContext.runId, settleInput, { announce: true }).catch((error) => {
			log.logWarn("subagent.settle.failed", "Detached run settlement failed", {
				reason: errorMessage(error),
				fields: { runId: runContext.runId },
			});
		});
	});

	return {
		content: [
			{
				type: "text",
				text:
					mutatesNote +
					buildDispatchedText(runContext.runId, config.name, "internal, async", runContext.workingDirectory),
			},
		],
		details: createDetails({
			config,
			runContext,
			usage: state.usage,
			turns: state.assistantTurns,
			toolCalls: state.toolCalls,
			durationMs: Date.now() - state.startedAt,
			dispatched: true,
		}),
	};
}

interface RunToCompletionContext {
	options: SubAgentToolOptions;
	config: ResolvedInternalSubAgentConfig;
	runContext: SubAgentRunContext;
	params: DelegationParams;
	state: InternalRunState;
	retryBackoff: AbortController;
	emitUpdate: (text: string) => void;
	worker: SubAgentWorker;
	unsubscribe: () => void;
	wallClockTimer: ReturnType<typeof setTimeout>;
	mutatesNote: string;
	workspaceBaseline: WorkspaceBaseline | undefined;
}

/**
 * Runs the worker to completion, including the D6 convergence turn, and returns the
 * tool result plus the data `runs.ts` needs to settle.
 */
async function runToCompletion(ctx: RunToCompletionContext) {
	const { options, config, runContext, params, state, retryBackoff, emitUpdate, worker } = ctx;
	try {
		const contextualBlocks = await resolveContextualBlocks(config, options);
		if (state.externallyCancelled) {
			state.failureReason = state.failureReason || "Cancelled by request.";
		} else {
			await worker.prompt(
				buildSubAgentTask(params.task, config, options.runtimeContext, contextualBlocks, runContext),
			);
			await worker.waitForIdle();
			await recoverFromProviderErrors({ worker, options, config, state, retryBackoff, emitUpdate });
		}

		// D6: a self-inflicted budget abort gets one tool-free turn to converge on a
		// conclusion instead of discarding the work outright. An explicit cancel skips
		// this — the model asked this run to stop now, not to wrap up.
		if (state.budgetExceeded && !state.externallyCancelled) {
			clearTimeout(ctx.wallClockTimer);
			emitUpdate(formatStatus(config.name, "converging on budget exhaustion"));
			const preConvergenceMessageCount = worker.state.messages.length;
			worker.state.tools = [];
			let convergenceTimedOut = false;
			const convergenceTimer = setTimeout(() => {
				convergenceTimedOut = true;
				worker.abort();
			}, options.convergenceWallClockMs ?? CONVERGENCE_WALL_CLOCK_MS);
			try {
				await worker.prompt(CONVERGENCE_PROMPT);
				await worker.waitForIdle();
			} catch {
				// Best effort: fall through to whatever worker.state.messages holds.
			} finally {
				clearTimeout(convergenceTimer);
			}
			if (convergenceTimedOut) {
				// Revert to the pre-D6 behavior: drop the (aborted, possibly partial)
				// convergence turn and fall back to whatever came before it.
				worker.state.messages = worker.state.messages.slice(0, preConvergenceMessageCount);
			}
		}
	} finally {
		ctx.unsubscribe();
		clearTimeout(ctx.wallClockTimer);
	}
	return buildInternalOutcome({
		worker,
		config,
		runContext,
		state,
		mutatesNote: ctx.mutatesNote,
		workspaceBaseline: ctx.workspaceBaseline,
		emitUpdate,
	});
}

/** Setup threw after the run was registered: undo what was armed, settle it failed, rethrow. */
async function failSetup(
	error: unknown,
	handle: WorkerHandle,
	state: InternalRunState,
	runManager: SubAgentRunManager,
	runContext: SubAgentRunContext,
): Promise<never> {
	handle.unsubscribe?.();
	if (handle.wallClockTimer) clearTimeout(handle.wallClockTimer);
	runManager.clearCancelHandle(runContext.runId);
	try {
		handle.worker?.abort();
	} catch {
		// Preserve the setup error; settlement below is the lifecycle authority.
	}
	const setupError = error instanceof Error ? error : new Error(String(error));
	await runManager.settle(
		runContext.runId,
		{
			status: "failed",
			failureReason: setupError.message,
			usage: state.usage,
			usageKnown: true,
			costKnown: true,
			turns: state.assistantTurns,
			toolCalls: state.toolCalls,
			durationMs: Date.now() - state.startedAt,
			outputText: "",
		},
		{ announce: false },
	);
	throw setupError;
}
