/**
 * The epilogue of a turn, shared by every exit path out of `ChannelRunner.run()`: the debug dump,
 * telling the channel how the turn ended, usage and ledger accounting, the end-of-turn memory
 * flush, and clearing run state.
 */
import { writeFile } from "fs/promises";
import { join } from "path";
import type { TurnOutcome } from "../../channel/channel-context.js";
import type { DeskConversation } from "../../desk/types.js";
import * as log from "../../log.js";
import { formatModelReference } from "../../models/reference.js";
import { errorMessage } from "../../shared/text-utils.js";
import type { UsageLedger } from "../../usage/ledger.js";
import { buildPromptManifest } from "../prompt/manifest.js";
import { snapshotContext } from "../session/context-snapshot.js";
import { getLastAssistantUsage } from "../session/event-guards.js";
import type { ModelSelection } from "../session/model-selection.js";
import type { SessionHost } from "../session/session-host.js";
import type { FinalOutcome, RunState } from "../types.js";
import type { createRunQueue } from "./run-queue.js";
import { renderTurnErrorReply } from "./turn-error.js";
import type { TurnOutput } from "./turn-output.js";
import type { TurnHandle, TurnStateMachine } from "./turn-state.js";

function isSilentOutcome(outcome: FinalOutcome): outcome is { kind: "silent" } {
	return outcome.kind === "silent";
}

export interface TurnFinisherDeps {
	requestScoped?: boolean;
	conversation: DeskConversation;
	host: SessionHost;
	models: ModelSelection;
	ledger: UsageLedger;
	turnState: TurnStateMachine;
	/** The live run state: `ChannelRunner` replaces it at the start of every run. */
	getRunState: () => RunState;
	flushMemoryActivity: () => Promise<void>;
	/** Release the turn, for a `run()` that owned the whole turn itself (no transport wrapper). */
	endTurn: () => void;
}

export class TurnFinisher {
	private readonly channelId: string;
	private readonly desk: string;
	/** The debug prompt dump is per conversation: two channels of one desk must not overwrite each other's. */
	private readonly conversationDir: string;
	private readonly host: SessionHost;
	private readonly models: ModelSelection;
	private readonly ledger: UsageLedger;
	private readonly turnState: TurnStateMachine;

	constructor(private readonly deps: TurnFinisherDeps) {
		this.channelId = deps.conversation.channelId;
		this.desk = deps.conversation.desk;
		this.conversationDir = deps.conversation.conversationDir;
		this.host = deps.host;
		this.models = deps.models;
		this.ledger = deps.ledger;
		this.turnState = deps.turnState;
	}

	private get runState(): RunState {
		return this.deps.getRunState();
	}

	/** How the turn ended, in the channel's terms. An error that came after an answer is still a completed turn. */
	private outcomeOf(fallbackAttempted: boolean, fallbackTargetRef: string | undefined): TurnOutcome {
		const { runState } = this;
		const usage = { ...runState.totalUsage, cost: { ...runState.totalUsage.cost } };
		if (runState.stopReason === "error" && runState.errorMessage && !runState.answerEmitted) {
			const compactionError = runState.lastCompactionError;
			return {
				kind: "failed",
				usage,
				message: renderTurnErrorReply({
					errorMessage: runState.errorMessage,
					compactionError:
						compactionError && compactionError !== runState.errorMessage ? compactionError : undefined,
					fallbackRef: fallbackAttempted ? fallbackTargetRef : undefined,
				}),
			};
		}
		if (isSilentOutcome(runState.finalOutcome)) return { kind: "silent", usage };
		if (runState.stopReason === "aborted" && !runState.answerEmitted) return { kind: "cancelled", usage };
		return { kind: "completed", usage };
	}

	/**
	 * The epilogue shared by every exit path out of `run()`'s try/catch: debug dump, delivery of
	 * whatever final message the turn settled on, usage/ledger accounting, the end-of-turn memory
	 * flush, and clearing run state. Pulled out of `run()` itself only to keep that method's main
	 * line (prepare → prompt with fallback) readable; every input here is `run()`-local, not
	 * instance state, so it is threaded through explicitly rather than promoted to a field.
	 */
	async finish(input: {
		ctx: TurnOutput;
		ownTurn: TurnHandle;
		implicitTurn: boolean;
		promptSubmitted: boolean;
		runQueue: ReturnType<typeof createRunQueue>;
		fallbackAttempted: boolean;
		fallbackTargetRef: string | undefined;
		promptText: string;
		durableMemoryBootstrapText: string;
		taskDigestText: string;
	}): Promise<void> {
		const { ctx, ownTurn, implicitTurn, promptSubmitted, runQueue, fallbackAttempted, fallbackTargetRef } = input;
		this.turnState.setPhase(ownTurn, "finishing");
		// Debug dump (PIPICLAW_DEBUG=1). Written after the run so `systemPrompt` is the
		// string the provider actually received — base sections, pi's tail, and the boundary
		// footer the prompt extension appends at before_agent_start.
		if (process.env.PIPICLAW_DEBUG && !this.deps.requestScoped) {
			const debugContext = {
				systemPrompt: this.host.lastFinalPrompt ?? this.host.agent.state.systemPrompt,
				promptManifest: this.host.lastPromptBuild
					? buildPromptManifest(this.host.lastPromptBuild, this.host.lastFinalPrompt)
					: undefined,
				messages: this.host.session.messages,
				durableMemoryBootstrap: input.durableMemoryBootstrapText || undefined,
				taskDigest: input.taskDigestText || undefined,
				newUserMessage: input.promptText,
			};
			await writeFile(join(this.conversationDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2)).catch(
				(error: unknown) =>
					log.logWarn("agent.debug.dump_failed", "last_prompt.json write failed", {
						channelId: this.channelId,
						reason: errorMessage(error),
					}),
			);
		}
		if (!promptSubmitted) {
			const discarded = this.host.session.clearQueue();
			const discardedCount = discarded.steering.length + discarded.followUp.length;
			if (discardedCount > 0) {
				log.logWarn("agent.turn.queue_discarded", "Queued busy messages discarded after run setup failed", {
					channelId: this.channelId,
					fields: { count: discardedCount },
				});
			}
		}
		await runQueue.drain();
		// The transport turns this into its own ending: a closed card, a settled response, a
		// delivered fallback for an answer that did not get through.
		await ctx.finish({
			...this.outcomeOf(fallbackAttempted, fallbackTargetRef),
			executionDesk: this.desk,
			...(promptSubmitted ? { continuation: snapshotContext(this.host.session.messages) } : {}),
		});

		// Log usage summary. Gated on tokens as well as cost: a local (or pricing-less) model
		// bills nothing, and skipping it here left both the log and the ledger empty.
		if (this.runState.totalUsage.cost.total > 0 || this.runState.totalUsage.total > 0) {
			const lastAssistantMessage = getLastAssistantUsage(this.host.session.messages);

			const contextTokens = lastAssistantMessage
				? lastAssistantMessage.usage.input +
					lastAssistantMessage.usage.output +
					lastAssistantMessage.usage.cacheRead +
					lastAssistantMessage.usage.cacheWrite
				: 0;
			const currentRunModel = this.host.session.model ?? this.models.activeModel;
			const contextWindow = currentRunModel.contextWindow || 200000;

			log.logUsageSummary(this.runState.logCtx!, this.runState.totalUsage, contextTokens, contextWindow);
			const responseModel = lastAssistantMessage?.responseModel;
			// Ledger turn entry: assistant-only usage (sub-agents recorded separately),
			// keeping Σ(entries) == real spend with no double counting.
			this.ledger.record({
				channelId: this.channelId,
				desk: this.desk,
				kind: "turn",
				model: responseModel ?? formatModelReference(currentRunModel),
				usage: {
					input: this.runState.assistantUsage.input,
					output: this.runState.assistantUsage.output,
					cacheRead: this.runState.assistantUsage.cacheRead,
					cacheWrite: this.runState.assistantUsage.cacheWrite,
					total: this.runState.assistantUsage.total,
				},
				cost: { ...this.runState.assistantUsage.cost },
			});
			if (
				responseModel &&
				responseModel !== formatModelReference(currentRunModel) &&
				responseModel !== currentRunModel.id
			) {
				log.logInfo(
					`[${this.channelId}] Actual model: ${responseModel} (configured: ${formatModelReference(currentRunModel)})`,
				);
			}
		}

		// The turn is over, so the channel is about to look idle to the maintenance gates —
		// which is exactly when this state has to be on disk. Everything buffered during the
		// turn lands here in one write.
		await this.deps.flushMemoryActivity();

		// Clear run state
		this.runState.ctx = null;
		this.runState.logCtx = null;
		this.runState.queue = null;
		if (implicitTurn) {
			this.deps.endTurn();
		}
	}
}
