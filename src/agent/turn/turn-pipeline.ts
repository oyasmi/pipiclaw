/**
 * The steps that turn a user's message into a submitted prompt: preparing the input, gathering the
 * turn-dynamic context, preparing images, the preventive-compaction guard, the seams the model
 * fallback drives, and queueing a steer into a running turn. Stateless apart from the per-turn
 * `TurnProgress` it fills in; `ChannelRunner.run()` calls these in order.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { InboundImage } from "../../channel/channel-event.js";
import type { TurnInfo } from "../../channel/transport.js";
import type { DeskConversation } from "../../desk/types.js";
import * as log from "../../log.js";
import type { FallbackRunDeps } from "../../models/fallback.js";
import { formatModelReference } from "../../models/reference.js";
import { errorMessage } from "../../shared/text-utils.js";
import type { ModelSelection } from "../session/model-selection.js";
import { SessionRetryAttempt } from "../session/session-adapter.js";
import type { SessionHost } from "../session/session-host.js";
import { MAX_USER_MESSAGE_CHARS, type RunState } from "../types.js";
import { estimateIncomingMessageTokens } from "./context-budget.js";
import { clipUserInput } from "./progress-formatter.js";
import { buildFirstTurnMemoryBootstrap, buildTaskDigestForTurn, renderDeskTurnContext } from "./turn-context.js";
import { renderFallbackSwitch } from "./turn-error.js";
import {
	formatUserMessage,
	type PreparedInboundImages,
	persistOversizedInput,
	prepareInboundImages,
	shouldPreserveRawInput,
} from "./turn-input.js";
import type { TurnOutput } from "./turn-output.js";
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
	conversation: DeskConversation;
	workspaceDir: string;
	/** The channel's human name for the capsule; absent when the channel index has none. */
	describeChannel?: (channelId: string) => string | undefined;
	host: SessionHost;
	models: ModelSelection;
	turnState: TurnStateMachine;
	isRetired: () => boolean;
	/** The live run state: `ChannelRunner` replaces it at the start of every run. */
	getRunState: () => RunState;
}

export class TurnPipeline {
	private readonly conversation: DeskConversation;
	private readonly channelId: string;
	private readonly deskDir: string;
	private readonly workspaceDir: string;
	private readonly host: SessionHost;
	private readonly models: ModelSelection;
	private readonly turnState: TurnStateMachine;

	constructor(private readonly deps: TurnPipelineDeps) {
		this.conversation = deps.conversation;
		this.channelId = deps.conversation.channelId;
		this.deskDir = deps.conversation.deskDir;
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
		turn: TurnInfo,
		ctx: TurnOutput,
	): Promise<{ clippedInput: string; userMessage: string; preserveRawInput: boolean }> {
		const normalizedInputLength = turn.text.replace(/\r/g, "").trim().length;
		let oversizedInputPath: string | undefined;
		if (normalizedInputLength > MAX_USER_MESSAGE_CHARS) {
			oversizedInputPath = await persistOversizedInput(this.deskDir, this.channelId, turn.text);
			ctx.emit({
				type: "commentary",
				level: "notice",
				text: oversizedInputPath
					? `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理；完整内容已存到 \`${oversizedInputPath}\`，需要时让我读取这个文件查看被省略的部分。`
					: `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理。`,
			});
		}
		const clippedInput = clipUserInput(turn.text, MAX_USER_MESSAGE_CHARS, oversizedInputPath);
		return {
			clippedInput,
			userMessage: formatUserMessage(clippedInput, turn.userName),
			preserveRawInput: shouldPreserveRawInput(turn.text),
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
		const channelCapsuleText = renderDeskTurnContext(
			this.conversation,
			this.deps.describeChannel?.(this.channelId),
			this.workspaceDir,
		);

		// The task digest reads the whole tasks/ directory and depends on nothing the memory
		// bootstrap below produces, so it runs alongside it rather than queuing behind it.
		// Settled into a result object rather than left as a bare promise: if the bootstrap
		// throws first we would otherwise leave a rejection unobserved, which Node's default
		// policy turns into a process exit. Rethrown at the await, so a digest failure still
		// fails the turn exactly as it did when this ran inline. A task step gets none: its brief
		// already carries its own task, and the channel's other tasks are noise there.
		const taskDigestPromise = (
			this.host.tasksEnabled && !this.host.taskLoop
				? buildTaskDigestForTurn(this.deskDir, this.channelId)
				: Promise.resolve("")
		).then(
			(text) => ({ text }) as { text: string; error?: never },
			(error: unknown) => ({ error }) as { text?: never; error: unknown },
		);

		// Spec 050, D1: the memory index is injected in full on the first turn of a session
		// (and the first turn after compaction — see `subscribeToSessionEvents`), never per
		// turn. Mid-session, the model uses `memory_search` to look things up.
		if (this.host.firstTurnMemoryBootstrapPending) {
			turn.durableMemoryBootstrapText = await buildFirstTurnMemoryBootstrap(this.deskDir, this.workspaceDir);
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
	async prepareTurnImages(turn: TurnInfo, ctx: TurnOutput): Promise<PreparedInboundImages> {
		const prepared = await prepareInboundImages(turn.images, this.session.model ?? this.models.activeModel);
		for (const notice of prepared.notices) {
			ctx.emit({ type: "commentary", level: "notice", text: notice });
		}
		return prepared;
	}

	/** The seams `runPromptWithFallback` drives: submit the prompt, observe/reset the error, switch model. */
	buildFallbackDeps(info: TurnInfo, ctx: TurnOutput, turn: TurnProgress, ownTurn: TurnHandle): FallbackRunDeps {
		let attempt: SessionRetryAttempt | undefined;
		const canRetry = () =>
			!this.deps.isRetired() &&
			this.turnState.current() === ownTurn &&
			!ownTurn.stopRequested &&
			(!attempt || this.host.session === attempt.session);
		const imported = Boolean(info.context?.messages.length);
		const submit = async (session: AgentSession, text: string) => {
			const revision = this.host.compaction.revision;
			const prompt = () =>
				session.prompt(text, turn.images.images.length > 0 ? { images: turn.images.images } : undefined);
			if (imported && info.context) {
				this.runState.userMessagesStarted = 1;
				await this.host.promptContext(info.context);
			} else if (info.context) await this.host.promptContext(info.context, prompt);
			else await prompt();
			turn.promptSubmitted = true;
			if (turn.bootstrapPrepared && revision === this.host.compaction.revision)
				this.host.firstTurnMemoryBootstrapPending = false;
		};
		return {
			prompt: async (text) => {
				try {
					await this.host.runPrompt(async () => {
						if (!canRetry()) return;
						if (imported && info.context) this.host.importContext(info.context);
						attempt = new SessionRetryAttempt(this.session, imported);
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
				// The retried prompt is this turn's first user message again, not an injected one.
				this.runState.userMessagesStarted = 0;
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
				turn.images = await this.prepareTurnImages(info, ctx);
			},
			notifySwitch: (from, to, errorSummary) => {
				turn.fallbackTargetRef = to;
				if (this.runState.logCtx) {
					log.logModelFallback(this.runState.logCtx, from, to, errorSummary);
				}
				ctx.emit({ type: "commentary", level: "warning", text: renderFallbackSwitch(from, to, errorSummary) });
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
		const oversizedPath = oversized ? await persistOversizedInput(this.deskDir, this.channelId, text) : undefined;
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
			this.runState.ctx?.emit({ type: "commentary", level: "notice", text: notice });
		}

		this.assertBusyWindowOpen();

		const queueMessage = async () => {
			this.assertBusyWindowOpen();
			await this.session.steer(queuedMessage, preparedImages.images.length > 0 ? preparedImages.images : undefined);
		};

		await this.host.runPrompt(queueMessage);
	}

	async maybeRunPreventiveCompactionForIncomingText(incomingText: string, imageCount: number = 0): Promise<void> {
		if (incomingText.trimStart().startsWith("/")) return;
		if (!this.host.settingsManager.getCompactionEnabled()) {
			this.host.compaction.cancel("disabled");
			return;
		}
		await this.host.compaction.beforePrompt(estimateIncomingMessageTokens(incomingText, imageCount));
	}
}
