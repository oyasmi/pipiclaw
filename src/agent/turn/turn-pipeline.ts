/**
 * The steps that turn a user's message into a submitted prompt: preparing the input, gathering the
 * turn-dynamic context, preparing images, the preventive-compaction guard, the seams the model
 * fallback drives, and queueing a steer into a running turn. Stateless apart from the per-turn
 * `TurnProgress` it fills in; `ChannelRunner.run()` calls these in order.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChannelContext } from "../../channel/channel-context.js";
import type { InboundImage } from "../../channel/channel-event.js";
import * as log from "../../log.js";
import type { FallbackRunDeps } from "../../models/fallback.js";
import { formatModelReference } from "../../models/reference.js";
import { errorMessage } from "../../shared/text-utils.js";
import type { ModelSelection } from "../session/model-selection.js";
import { SessionRetryAttempt } from "../session/session-adapter.js";
import type { SessionHost } from "../session/session-host.js";
import { MAX_USER_MESSAGE_CHARS, type RunState } from "../types.js";
import { estimateIncomingMessageTokens, getPreventiveCompactionDecision } from "./context-budget.js";
import { clipUserInput, formatProgressEntry } from "./progress-formatter.js";
import type { createRunQueue } from "./run-queue.js";
import { buildFirstTurnMemoryBootstrap, buildTaskDigestForTurn, renderChannelTurnContext } from "./turn-context.js";
import { renderFallbackSwitch } from "./turn-error.js";
import {
	formatUserMessage,
	type PreparedInboundImages,
	persistOversizedInput,
	prepareInboundImages,
	shouldPreserveRawInput,
} from "./turn-input.js";
import type { TurnHandle, TurnStateMachine } from "./turn-state.js";

/** What `run()` accumulates across its steps; the epilogue reports it as the turn was actually sent. */
export interface TurnProgress {
	promptSubmitted: boolean;
	fallbackAttempted: boolean;
	fallbackTargetRef: string | undefined;
	promptText: string;
	taskDigestText: string;
	durableMemoryBootstrapText: string;
	bootstrapPrepared: boolean;
	images: PreparedInboundImages;
}

export function createTurnProgress(): TurnProgress {
	return {
		promptSubmitted: false,
		fallbackAttempted: false,
		fallbackTargetRef: undefined,
		promptText: "",
		taskDigestText: "",
		durableMemoryBootstrapText: "",
		bootstrapPrepared: false,
		images: { images: [], notices: [] },
	};
}

export interface TurnPipelineDeps {
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	host: SessionHost;
	models: ModelSelection;
	turnState: TurnStateMachine;
	isRetired: () => boolean;
	/** The live run state: `ChannelRunner` replaces it at the start of every run. */
	getRunState: () => RunState;
}

export class TurnPipeline {
	private readonly channelId: string;
	private readonly channelDir: string;
	private readonly workspaceDir: string;
	private readonly host: SessionHost;
	private readonly models: ModelSelection;
	private readonly turnState: TurnStateMachine;

	constructor(private readonly deps: TurnPipelineDeps) {
		this.channelId = deps.channelId;
		this.channelDir = deps.channelDir;
		this.workspaceDir = deps.workspaceDir;
		this.host = deps.host;
		this.models = deps.models;
		this.turnState = deps.turnState;
	}

	private get runState(): RunState {
		return this.deps.getRunState();
	}

	private get session(): AgentSession {
		return this.host.session;
	}

	/** Oversized input is spilled to disk and clipped; the user is told. Slash commands pass through raw. */
	async prepareUserInput(
		ctx: ChannelContext,
	): Promise<{ clippedInput: string; userMessage: string; preserveRawInput: boolean }> {
		const normalizedInputLength = ctx.message.text.replace(/\r/g, "").trim().length;
		let oversizedInputPath: string | undefined;
		if (normalizedInputLength > MAX_USER_MESSAGE_CHARS) {
			oversizedInputPath = await persistOversizedInput(this.channelDir, this.channelId, ctx.message.text);
			await ctx.respondInThread(
				oversizedInputPath
					? `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理；完整内容已存到 \`${oversizedInputPath}\`，需要时让我读取这个文件查看被省略的部分。`
					: `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理。`,
			);
		}
		const clippedInput = clipUserInput(ctx.message.text, MAX_USER_MESSAGE_CHARS, oversizedInputPath);
		return {
			clippedInput,
			userMessage: formatUserMessage(clippedInput, ctx.message.userName),
			preserveRawInput: shouldPreserveRawInput(ctx.message.text),
		};
	}

	/**
	 * The turn-dynamic context: the channel capsule (returned) plus, recorded on `turn`, the task
	 * digest and the first-turn memory bootstrap. A raw-passthrough input (a slash command) gets none.
	 */
	async gatherTurnContext(preserveRawInput: boolean, turn: TurnProgress): Promise<string> {
		if (preserveRawInput) return "";
		// Channel facts are turn-dynamic by design (spec 025 §7.3): keeping them out of the
		// system prompt is what lets every channel in a workspace share one cached prefix.
		const channelCapsuleText = renderChannelTurnContext(this.channelDir);

		// The task digest reads the whole tasks/ directory and depends on nothing the memory
		// bootstrap below produces, so it runs alongside it rather than queuing behind it.
		// Settled into a result object rather than left as a bare promise: if the bootstrap
		// throws first we would otherwise leave a rejection unobserved, which Node's default
		// policy turns into a process exit. Rethrown at the await, so a digest failure still
		// fails the turn exactly as it did when this ran inline. A task step gets none: its brief
		// already carries its own task, and the channel's other tasks are noise there.
		const taskDigestPromise = (
			this.host.tasksEnabled && !this.host.taskLoop ? buildTaskDigestForTurn(this.channelDir) : Promise.resolve("")
		).then(
			(text) => ({ text }) as { text: string; error?: never },
			(error: unknown) => ({ error }) as { text?: never; error: unknown },
		);

		// Spec 050, D1: the memory index is injected in full on the first turn of a session
		// (and the first turn after compaction — see `subscribeToSessionEvents`), never per
		// turn. Mid-session, the model uses `memory_search` to look things up.
		if (this.host.firstTurnMemoryBootstrapPending) {
			turn.durableMemoryBootstrapText = await buildFirstTurnMemoryBootstrap(this.channelDir, this.workspaceDir);
			turn.bootstrapPrepared = true;
		}

		const taskDigestResult = await taskDigestPromise;
		if (taskDigestResult.error !== undefined) {
			throw taskDigestResult.error;
		}
		turn.taskDigestText = taskDigestResult.text ?? "";
		return channelCapsuleText;
	}

	/** Inbound images for the current model, with a notice to the user for each one that was left out. */
	async prepareTurnImages(ctx: ChannelContext): Promise<PreparedInboundImages> {
		const prepared = await prepareInboundImages(ctx.message.images, this.session.model ?? this.models.activeModel);
		for (const notice of prepared.notices) {
			await ctx.respondInThread(notice);
		}
		return prepared;
	}

	/** The seams `runPromptWithFallback` drives: submit the prompt, observe/reset the error, switch model. */
	buildFallbackDeps(
		ctx: ChannelContext,
		runQueue: ReturnType<typeof createRunQueue>,
		turn: TurnProgress,
		ownTurn: TurnHandle,
	): FallbackRunDeps {
		let attempt: SessionRetryAttempt | undefined;
		const canRetry = () =>
			!this.deps.isRetired() &&
			this.turnState.current() === ownTurn &&
			!ownTurn.stopRequested &&
			(!attempt || this.host.session === attempt.session);
		const submit = async (session: AgentSession, text: string) => {
			await session.prompt(text, turn.images.images.length > 0 ? { images: turn.images.images } : undefined);
			turn.promptSubmitted = true;
			if (turn.bootstrapPrepared) this.host.firstTurnMemoryBootstrapPending = false;
		};
		return {
			prompt: async (text) => {
				try {
					await this.host.runPrompt(async () => {
						if (!canRetry()) return;
						attempt = new SessionRetryAttempt(this.session);
						await submit(attempt.session, text);
					});
				} catch (err) {
					this.runState.stopReason = "error";
					this.runState.errorMessage = errorMessage(err);
					log.logEvent("error", "agent.turn.failed", "Runner failed", {
						ctx: this.runState.logCtx ?? { channelId: this.channelId },
						fields: { error: this.runState.errorMessage },
					});
				}
			},
			getRunError: () => ({
				stopReason: this.runState.stopReason,
				errorMessage: this.runState.errorMessage,
			}),
			resetRunError: () => {
				this.runState.stopReason = "stop";
				this.runState.errorMessage = undefined;
				this.runState.finalOutcome = { kind: "none" };
				this.runState.lastCompactionError = undefined;
			},
			canRetry,
			prepareRetry: () => {
				const captured = attempt;
				const classified = captured?.prepare();
				if (!captured || !classified || !canRetry()) return null;
				return {
					kind: classified.kind,
					run: (text, onReady) =>
						this.host.runPrompt(async () => {
							if (!canRetry()) return "stale";
							try {
								if (!captured.omitFailedContext()) return "stale";
							} catch (error) {
								throw this.host.markContextFault(captured.session, error);
							}
							if (!canRetry()) return "stale";
							onReady();
							await submit(captured.session, text);
							return "attempted";
						}),
				};
			},
			getCurrentModelRef: () => formatModelReference(this.session.model ?? this.models.activeModel),
			resolveFallbackModel: () => this.models.resolveFallbackModel(),
			setModel: async (model) => {
				await this.models.setModelWithThinkingPreservation(model);
				if (!canRetry()) return;
				// The fallback model's vision support can differ from the one this turn started
				// on; re-resolve against it rather than resend whatever was prepared for the
				// model that just failed.
				turn.images = await this.prepareTurnImages(ctx);
			},
			notifySwitch: (from, to, errorSummary) => {
				turn.fallbackTargetRef = to;
				if (this.runState.logCtx) {
					log.logModelFallback(this.runState.logCtx, from, to, errorSummary);
				}
				const text = renderFallbackSwitch(from, to, errorSummary);
				if (ctx.progressStyle !== "none") {
					runQueue.queue.enqueue(() => ctx.respond(formatProgressEntry("error", text), false), "fallback switch");
				} else {
					runQueue.queue.enqueue(() => ctx.respondInThread(`⚠️ ${text}`), "fallback switch");
				}
			},
			markPrimaryFailed: () => {
				this.models.markPrimaryFailed();
			},
		};
	}

	/**
	 * Single source of truth for the busy-message window: steer is accepted while
	 * the prompt is being assembled ("preparing") or while the agent loop is
	 * actually streaming. Re-asserted after every await because the turn can end
	 * while this call was suspended.
	 */
	private assertBusyWindowOpen(): void {
		if (this.turnState.phase() === "preparing") {
			return;
		}
		if (this.turnState.phase() === "streaming" && this.session.isStreaming) {
			return;
		}
		throw new Error("No task is currently running.");
	}

	async queueBusyMessage(text: string, userName?: string, images?: InboundImage[]): Promise<void> {
		this.assertBusyWindowOpen();

		await this.host.ensureSessionReady();

		const oversized = text.replace(/\r/g, "").trim().length > MAX_USER_MESSAGE_CHARS;
		const oversizedPath = oversized ? await persistOversizedInput(this.channelDir, this.channelId, text) : undefined;
		const clippedText = clipUserInput(text, MAX_USER_MESSAGE_CHARS, oversizedPath);
		if (oversized) {
			log.logWarn("agent.input.clipped", "Queued message clipped", {
				channelId: this.channelId,
				fields: { limitChars: MAX_USER_MESSAGE_CHARS },
			});
		}
		const queuedMessage = formatUserMessage(clippedText, userName);
		const preparedImages = await prepareInboundImages(images, this.session.model ?? this.models.activeModel);
		for (const notice of preparedImages.notices) {
			await this.runState.ctx?.respondInThread(notice);
		}
		await this.maybeRunPreventiveCompactionForIncomingText(queuedMessage, preparedImages.images.length);

		this.assertBusyWindowOpen();

		const queueMessage = async () => {
			this.assertBusyWindowOpen();
			await this.session.steer(queuedMessage, preparedImages.images.length > 0 ? preparedImages.images : undefined);
		};

		await this.host.runPrompt(queueMessage);
	}

	async maybeRunPreventiveCompactionForIncomingText(incomingText: string, imageCount: number = 0): Promise<void> {
		const currentModel = this.session.model ?? this.models.activeModel;
		const contextUsage = this.session.getContextUsage();
		const contextTokens = contextUsage?.tokens;
		const incomingTokens = estimateIncomingMessageTokens(incomingText, imageCount);
		const decision = getPreventiveCompactionDecision(contextTokens, incomingTokens, currentModel.contextWindow);

		if (!decision.shouldCompact) {
			return;
		}

		const currentTokens = contextTokens ?? 0;
		const startedAt = Date.now();
		log.logInfo(
			`[${this.channelId}] Preventive compaction triggered: projected ${decision.projectedTokens}/${currentModel.contextWindow} tokens (current=${currentTokens}, incoming≈${incomingTokens}), threshold=${decision.thresholdTokens}`,
		);

		try {
			await this.session.compact();
			log.logInfo(`[${this.channelId}] Preventive compaction complete in ${Date.now() - startedAt}ms`);
		} catch (error) {
			const message = errorMessage(error);
			log.logWarn("agent.compaction.preventive_failed", "Preventive compaction failed", {
				channelId: this.channelId,
				reason: message,
			});
		}
	}
}
