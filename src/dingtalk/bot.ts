/**
 * The DingTalk side of the wire: owns the Stream connection, the AI cards, media and the plain-send
 * path, and hands every authorized inbound message to the runtime's ingress. It routes nothing and
 * queues nothing — commands, busy handling and turn ordering are the runtime's (spec 061, D6). The
 * Stream socket, access token, AI cards, media and inbound parsing are separate collaborators
 * (`connection.ts`, `access-token.ts`, `cards.ts`, `media.ts`, `inbound.ts`) that this class wires
 * together and forwards to.
 */
import type { MediaSendResult, OutboundMedia } from "../channel/transport.js";
import * as log from "../log.js";
import { AccessTokenProvider } from "./access-token.js";
import { type ConversationMeta, sendRobotMessage } from "./api.js";
import { CardController } from "./cards.js";
import { type BusyMessageMode, type DingTalkConfig, normalizeBusyMessageDefault } from "./config.js";
import { StreamConnection } from "./connection.js";
import { ConversationMetaStore } from "./conversation-meta.js";
import type { DeliveryPort } from "./delivery.js";
import { type DingTalkIngress, InboundMessages } from "./inbound.js";
import { DingTalkMedia } from "./media.js";
import {
	type FinalDelivery,
	finalDeliveryOf,
	normalizeResponseMode,
	type ProgressStyle,
	progressStyleOf,
	type ResponseMode,
} from "./response-mode.js";

// Channel metadata is persisted on disk, so these in-memory caches can be safely
// reclaimed after inactivity. A stale unfinished card falls back to a fresh card
// on the next update rather than retaining one channel forever.
const CHANNEL_CACHE_TTL_MS = 60 * 60 * 1000;
const CHANNEL_CACHE_SWEEP_MS = 10 * 60 * 1000;

export class DingTalkBot implements DeliveryPort {
	private config: DingTalkConfig;

	private tokens: AccessTokenProvider;
	private conversations: ConversationMetaStore;
	private cards: CardController;
	private media: DingTalkMedia;
	private inbound: InboundMessages;
	private connection: StreamConnection;

	private channelLastActiveAt = new Map<string, number>();
	private channelCacheSweepTimer: NodeJS.Timeout | null = null;
	private isStopped = false;

	constructor(ingress: DingTalkIngress, config: DingTalkConfig) {
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
			ingress,
			conversations: this.conversations,
			isStopped: () => this.isStopped,
			ack: (messageId) => this.connection.ack(messageId),
			collectAttachments: (parsed) => this.media.collectInboundAttachments(parsed),
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
		await this.connection.disconnect();
	}

	/**
	 * A turn is being processed: the keep-alive watchdog must not tear the socket down under it.
	 * Returns the release to call when the turn is over.
	 */
	holdConnection(): () => void {
		this.connection.beginMessageProcessing();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.connection.endMessageProcessing();
		};
	}

	/** Test seam (spec 048): true while an inbound message is still being downloaded or handed over. */
	hasPendingIngest(): boolean {
		return this.inbound.hasPendingIngest();
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
	// Media (image / file) delivery (see media.ts)
	// ==========================================================================

	sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		return this.media.sendMedia(channelId, media);
	}

	/**
	 * Inbound file fetch used while collecting attachments (`media.ts`). `protected` so the
	 * deterministic e2e harness can override it and run the inbound path with zero network, the
	 * same pattern `HarnessDingTalkBot` already uses for outbound calls.
	 */
	protected downloadMessageFile(downloadCode: string): Promise<{ data: Buffer } | null> {
		return this.media.downloadMessageFile(downloadCode);
	}

	private touchChannel(channelId: string): void {
		this.channelLastActiveAt.set(channelId, Date.now());
	}

	private cleanupIdleChannelCaches(now = Date.now()): void {
		const cutoff = now - CHANNEL_CACHE_TTL_MS;
		for (const [channelId, lastActiveAt] of this.channelLastActiveAt) {
			if (lastActiveAt > cutoff) continue;
			if (this.cards.hasCreationInFlight(channelId)) continue;

			if (this.cards.hasCardUpdatedSince(channelId, cutoff)) continue;
			this.cards.dropChannel(channelId);
			this.channelLastActiveAt.delete(channelId);
		}
	}
}
