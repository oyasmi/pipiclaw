/**
 * DingTalk transport facade: owns the per-channel queues and the public surface the runtime and the
 * delivery controller call. The Stream socket, access token, AI cards, media and inbound parsing
 * are separate collaborators (`connection.ts`, `access-token.ts`, `cards.ts`, `media.ts`,
 * `inbound.ts`) that this class wires together and forwards to.
 */
import {
	type FinalDelivery,
	finalDeliveryOf,
	type MediaSender,
	type MediaSendResult,
	normalizeResponseMode,
	type OutboundMedia,
	type ProgressStyle,
	progressStyleOf,
	type ResponseMode,
} from "../channel/channel-context.js";
import type { ChannelEventSink } from "../channel/channel-event.js";
import { formatBusyHint, parseBuiltInCommand, renderBuiltInHelp, slashCommandName } from "../commands/catalog.js";
import * as log from "../log.js";
import { AccessTokenProvider } from "./access-token.js";
import { type ConversationMeta, sendRobotMessage } from "./api.js";
import { CardController } from "./cards.js";
// Turn serialization is runtime policy; the queue lives in its own module and
// this transport only consumes it.
import { ChannelQueue } from "./channel-queue.js";
import { type BusyMessageMode, type DingTalkConfig, normalizeBusyMessageDefault } from "./config.js";
import { StreamConnection } from "./connection.js";
import { ConversationMetaStore } from "./conversation-meta.js";
import type { DingTalkBotPort, DingTalkEvent, DingTalkHandler } from "./handler.js";
import { InboundMessages } from "./inbound.js";
import { DingTalkMedia } from "./media.js";

// Bounds enqueueStreamMessage (user messages + busy-message requeues), mirroring the
// existing cap on enqueueEvent. Without a limit, a busy channel getting flooded with
// messages (or repeated followUp requeues) grows this queue without bound — each item
// still runs a full serialized turn, so an unbounded queue means unbounded backlog time
// and unbounded memory, not just a slow channel.
const USER_MESSAGE_QUEUE_LIMIT = 20;
const EVENT_QUEUE_LIMIT = 5;
// Channel metadata is persisted on disk, so these in-memory caches can be safely
// reclaimed after inactivity. A stale unfinished card falls back to a fresh card
// on the next update rather than retaining one channel forever.
const CHANNEL_CACHE_TTL_MS = 60 * 60 * 1000;
const CHANNEL_CACHE_SWEEP_MS = 10 * 60 * 1000;

export class DingTalkBot implements MediaSender, ChannelEventSink, DingTalkBotPort {
	private handler: DingTalkHandler;
	private config: DingTalkConfig;

	private tokens: AccessTokenProvider;
	private conversations: ConversationMetaStore;
	private cards: CardController;
	private media: DingTalkMedia;
	private inbound: InboundMessages;
	private connection: StreamConnection;

	private channelLastActiveAt = new Map<string, number>();

	// Per-channel queues
	private queues = new Map<string, ChannelQueue>();

	private channelCacheSweepTimer: NodeJS.Timeout | null = null;
	private isStopped = false;

	constructor(handler: DingTalkHandler, config: DingTalkConfig) {
		this.handler = handler;
		this.config = {
			...config,
			busyMessageDefault: normalizeBusyMessageDefault(config.busyMessageDefault),
			responseMode: normalizeResponseMode(config.responseMode),
			cardAutoLayout: config.cardAutoLayout ?? true,
		};
		this.channelCacheSweepTimer = setInterval(() => this.cleanupIdleChannelCaches(), CHANNEL_CACHE_SWEEP_MS);
		this.channelCacheSweepTimer.unref?.();

		this.tokens = new AccessTokenProvider(this.config);
		this.conversations = new ConversationMetaStore(this.config, (channelId) => this.touchChannel(channelId));
		const getAccessToken = () => this.tokens.get();
		const sendRobot = (meta: ConversationMeta, msgKey: string, msgParam: string) =>
			sendRobotMessage({ config: this.config, getAccessToken }, meta, msgKey, msgParam);
		this.cards = new CardController({
			config: this.config,
			getAccessToken,
			getConversationMeta: (channelId) => this.conversations.get(channelId),
			sendPlain: (channelId, text) => this.sendPlain(channelId, text),
		});
		this.media = new DingTalkMedia({
			config: this.config,
			handler: this.handler,
			getAccessToken,
			getConversationMeta: (channelId) => this.conversations.get(channelId),
			sendRobotMessage: sendRobot,
			downloadMessageFile: (downloadCode) => this.downloadMessageFile(downloadCode),
		});
		this.connection = new StreamConnection({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
			isStopped: () => this.isStopped,
			onRawMessage: (msg) => this.inbound.handleRawMessage(msg),
		});
		this.inbound = new InboundMessages({
			config: this.config,
			handler: this.handler,
			conversations: this.conversations,
			isStopped: () => this.isStopped,
			ack: (messageId) => this.connection.ack(messageId),
			resolveInboundAttachments: (channelId, parsed) => this.media.resolveInboundAttachments(channelId, parsed),
			routeInboundEvent: (event) => this.routeInboundEvent(event),
		});
	}

	get busyMessageDefault(): BusyMessageMode {
		return normalizeBusyMessageDefault(this.config.busyMessageDefault);
	}

	get responseMode(): ResponseMode {
		return normalizeResponseMode(this.config.responseMode);
	}

	get progressStyle(): ProgressStyle {
		return progressStyleOf(this.responseMode);
	}

	get finalDelivery(): FinalDelivery {
		return finalDeliveryOf(this.responseMode);
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		if (!this.config.clientId || !this.config.clientSecret) {
			log.logWarn("dingtalk.config.missing_credentials", "clientId / clientSecret not configured");
			return;
		}

		if (!this.config.cardTemplateId) {
			log.logWarn(
				"dingtalk.config.missing_card_template",
				"cardTemplateId not configured; AI Card streaming is off",
			);
		}

		log.logEvent("info", "runtime.dingtalk.connecting", "Initializing stream client", {
			fields: { clientIdPrefix: this.config.clientId.substring(0, 8) },
		});

		await this.connection.start();
	}

	async stop(): Promise<void> {
		log.logInfoEvent("dingtalk.bot.stopping", "Stopping bot");
		this.isStopped = true;
		this.connection.clearAllTimers();
		if (this.channelCacheSweepTimer) {
			clearInterval(this.channelCacheSweepTimer);
			this.channelCacheSweepTimer = null;
		}
		for (const queue of this.queues.values()) {
			queue.stop();
		}
		await this.connection.disconnect();
	}

	/**
	 * Enqueue an event for processing.
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: DingTalkEvent): boolean {
		if (this.isStopped) {
			return false;
		}
		const queue = this.getQueue(event.channelId);
		if (queue.size() >= EVENT_QUEUE_LIMIT) {
			log.logEvent("warn", "runtime.channel_queue.full", "Discarding incoming event", {
				ctx: { channelId: event.channelId, userName: event.userName },
				fields: { messageLength: event.text.length },
			});
			return false;
		}
		log.logEvent("debug", "runtime.channel_queue.enqueued", "Incoming event queued", {
			ctx: { channelId: event.channelId, userName: event.userName },
			fields: { messageLength: event.text.length },
		});
		queue.enqueue(async () => {
			this.connection.beginMessageProcessing();
			try {
				this.handler.reserveEvent?.(event);
				await this.handler.handleEvent(event, this, true);
			} finally {
				this.connection.endMessageProcessing();
			}
		});
		return true;
	}

	private enqueueStreamMessage(event: DingTalkEvent, textOverride?: string): void {
		const queuedEvent = textOverride === undefined ? event : { ...event, text: textOverride };
		const queue = this.getQueue(event.channelId);
		if (queue.size() >= USER_MESSAGE_QUEUE_LIMIT) {
			log.logWarn("dingtalk.queue.full", "Message discarded: channel queue full", {
				channelId: event.channelId,
				fields: { limit: USER_MESSAGE_QUEUE_LIMIT, preview: queuedEvent.text.substring(0, 50) },
			});
			this.sendPlain(
				event.channelId,
				`⚠️ 消息积压过多（超过 ${USER_MESSAGE_QUEUE_LIMIT} 条待处理），本条消息已丢弃，请稍后重试。`,
			).catch(() => undefined);
			return;
		}
		queue.enqueue(async () => {
			this.connection.beginMessageProcessing();
			try {
				this.handler.reserveEvent?.(queuedEvent);
				await this.handler.handleEvent(queuedEvent, this);
			} finally {
				this.connection.endMessageProcessing();
			}
		});
	}

	// ==========================================================================
	// AI Card operations (see cards.ts)
	// ==========================================================================

	/** Capture the current turn's identity; close, /stop and /new invalidate it. */
	getCardGeneration(channelId: string): symbol {
		return this.cards.getCardGeneration(channelId);
	}

	isCardGenerationCurrent(channelId: string, generation: symbol): boolean {
		return this.cards.isCardGenerationCurrent(channelId, generation);
	}

	/** Get or create an AI card without joining an earlier turn's in-flight creation. */
	async ensureCard(channelId: string, generation?: symbol): Promise<void> {
		return this.cards.ensureCard(channelId, generation);
	}

	/** Replace the active card content with a full snapshot. */
	async replaceCard(
		channelId: string,
		content: string,
		finalize: boolean = false,
		failed: boolean = false,
		generation?: symbol,
	): Promise<boolean> {
		return this.cards.replaceCard(channelId, content, finalize, failed, generation);
	}

	/** Append a delta to the active card transcript. */
	async appendToCard(
		channelId: string,
		content: string,
		finalize: boolean = false,
		failed: boolean = false,
		generation?: symbol,
	): Promise<boolean> {
		return this.cards.appendToCard(channelId, content, finalize, failed, generation);
	}

	/** Finalize and remove the active card for a channel. */
	async finalizeCard(channelId: string, content: string, generation?: symbol): Promise<boolean> {
		return this.cards.finalizeCard(channelId, content, generation);
	}

	/** Finish progress only: never create a card or send a fallback chat message. */
	async finalizeExistingCard(channelId: string, content: string, generation?: symbol): Promise<boolean> {
		return this.cards.finalizeExistingCard(channelId, content, generation);
	}

	/** Invalidate this turn's local state. This is not a remote message deletion. */
	discardCard(channelId: string, generation?: symbol): void {
		this.cards.discardCard(channelId, generation);
	}

	/**
	 * Send a normal message natively mapping DM and Group to correct endpoints (fallback when no card).
	 *
	 * Only the message shape is decided here; the DM-vs-group routing and the POST itself belong to
	 * `sendRobotMessage`, which every other outbound message type already goes through.
	 *
	 * `opts` lets a caller that already knows what it produced (a command reply) state the format
	 * and a real title instead of the regex guess below, which exists only for callers — free-form
	 * notices, `replaceWithFinal` — that do not know their own content ahead of time (review
	 * 2026-08-24 §1.3c).
	 */
	async sendPlain(channelId: string, text: string, opts?: { title?: string; markdown?: boolean }): Promise<boolean> {
		const meta = this.conversations.get(channelId);
		if (!meta) {
			log.logWarn("dingtalk.send.no_metadata", "Plain message not sent: no conversation metadata", {
				channelId: channelId,
			});
			return false;
		}

		const hasMarkdown = opts?.markdown ?? /^#{1,6}\s|^\s*[-*]\s|\*\*.*\*\*|```|`[^`]+`|\[.*?\]\(.*?\)/m.test(text);
		const title = opts?.title ?? "Bot";
		const msgKey = hasMarkdown ? "sampleMarkdown" : "sampleText";
		const msgParam = hasMarkdown ? JSON.stringify({ text, title }) : JSON.stringify({ content: text });

		return sendRobotMessage({ config: this.config, getAccessToken: () => this.tokens.get() }, meta, msgKey, msgParam);
	}

	// ==========================================================================
	// Media (image / file) delivery — MediaSender contract (see media.ts)
	// ==========================================================================

	sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		return this.media.sendMedia(channelId, media);
	}

	/**
	 * Inbound file fetch used while resolving attachments (`media.ts`). `protected` so the
	 * deterministic e2e harness can override it and run the inbound path with zero network, the
	 * same pattern `HarnessDingTalkBot` already uses for outbound calls.
	 */
	protected downloadMessageFile(downloadCode: string): Promise<{ data: Buffer } | null> {
		return this.media.downloadMessageFile(downloadCode);
	}

	/**
	 * Command / busy / `/new` routing for one inbound event, ending in `enqueueStreamMessage`
	 * for a normal message. Split out of `onStreamMessage` so the deterministic e2e harness
	 * (spec 048) can exercise the real transport queue and busy semantics without a socket.
	 */
	async routeInboundEvent(event: DingTalkEvent): Promise<void> {
		const { channelId } = event;
		const content = event.text;
		const builtInCommand = parseBuiltInCommand(content);
		const isSlashCommand = content.trim().startsWith("/");

		// `/new` is an emergency boundary as well as a session command. Route it before
		// busy checking and before the old channel queue, so a wedged compaction/provider
		// request cannot prevent recovery.
		if (slashCommandName(content) === "new") {
			await this.handler.handleNewSession(event, this);
			return;
		}

		// Check if busy
		if (this.handler.isRunning(channelId)) {
			// All built-in transport commands are usable while a task streams.
			if (builtInCommand) {
				switch (builtInCommand.name) {
					case "help":
						await this.sendPlain(channelId, renderBuiltInHelp(builtInCommand.args), {
							title: "/help",
							markdown: true,
						});
						return;
					case "stop": {
						const outcome = await this.handler.handleStop(channelId, this);
						await this.sendPlain(
							channelId,
							outcome.pausedTaskId
								? `已停止当前回合。任务 \`${outcome.pausedTaskId}\` 已暂停，用 \`/tasks resume ${outcome.pausedTaskId}\` 继续。`
								: "已停止当前回合。",
							{ title: "/stop", markdown: true },
						);
						return;
					}
					case "steer":
					case "followup": {
						const mode = builtInCommand.name === "steer" ? "steer" : "followUp";
						const result = await this.handler.handleBusyMessage(event, this, mode, builtInCommand.args);
						if (result.kind === "requeue") {
							this.enqueueStreamMessage(event, result.text);
						}
						return;
					}
					default: {
						// Every remaining BuiltInCommandName is a stateless report (events/tasks/status/usage/
						// context/subagents/project), narrowed to RuntimeCommandName by TS after the four
						// cases above. Busy has no sendCommandReply-style retry semantics, so `/context` is
						// answered here like the rest instead of the runner-handled path idle uses for it
						// (see the IDLE_RUNTIME_COMMAND_NAMES comment in bootstrap.ts).
						const response = await this.handler.runRuntimeCommand(
							event,
							builtInCommand.name,
							builtInCommand.args,
						);
						const delivered = await this.sendPlain(channelId, response, {
							title: `/${builtInCommand.name}`,
							markdown: true,
						});
						if (!delivered) {
							log.logWarn("delivery.command_reply.failed", "Command reply delivery failed", {
								channelId: channelId,
								fields: { command: builtInCommand.name, chars: response.length },
							});
						}
						return;
					}
				}
			}

			// Other session commands (/model, /compact, …) and unknown slash commands cannot
			// run mid-turn: they would need the idle session layer.
			if (isSlashCommand) {
				await this.sendPlain(channelId, formatBusyHint());
				return;
			}

			const result = await this.handler.handleBusyMessage(event, this, this.busyMessageDefault, content);
			if (result.kind === "requeue") {
				this.enqueueStreamMessage(event, result.text);
			}
			return;
		}

		// Enqueue for processing
		this.enqueueStreamMessage(event);
	}

	/**
	 * Drop queued-but-not-started messages for a channel (e.g. on /stop) so they
	 * do not run after the user halts the current task. Returns dropped count.
	 */
	clearPendingMessages(channelId: string): number {
		const queue = this.queues.get(channelId);
		return queue ? queue.clearPending() : 0;
	}

	/**
	 * Detach all queued work from the previous session generation. The in-flight callback may
	 * still unwind on its old queue object, while subsequent messages get a fresh queue.
	 */
	resetChannelQueue(channelId: string): number {
		const queue = this.queues.get(channelId);
		const dropped = queue?.clearPending() ?? 0;
		queue?.stop();
		this.queues.delete(channelId);
		this.discardCard(channelId);
		return dropped;
	}

	/** Test seam (spec 048): true when no channel queue has pending or in-flight work. */
	allChannelQueuesIdle(): boolean {
		if (this.inbound.hasPendingIngest()) return false;
		for (const queue of this.queues.values()) {
			if (!queue.isIdle()) return false;
		}
		return true;
	}

	private getQueue(channelId: string): ChannelQueue {
		this.touchChannel(channelId);
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private touchChannel(channelId: string): void {
		this.channelLastActiveAt.set(channelId, Date.now());
	}

	private cleanupIdleChannelCaches(now = Date.now()): void {
		const cutoff = now - CHANNEL_CACHE_TTL_MS;
		for (const [channelId, lastActiveAt] of this.channelLastActiveAt) {
			if (lastActiveAt > cutoff) continue;
			const queue = this.queues.get(channelId);
			if (!queue?.isIdle() || this.cards.hasCreationInFlight(channelId)) continue;

			if (this.cards.hasCardUpdatedSince(channelId, cutoff)) continue;
			this.cards.dropChannel(channelId);
			this.conversations.evict(channelId);
			this.queues.delete(channelId);
			this.channelLastActiveAt.delete(channelId);
		}
	}
}
