/**
 * DingTalk communication layer using dingtalk-stream SDK with AI Card streaming.
 *
 * Handles:
 * - Receiving messages via DingTalk Stream Mode (DWClient)
 * - Responding via AI Card (streaming) or plain markdown (fallback)
 * - Access token management
 * - Per-channel message queuing
 */
import axios from "axios";
import { DWClient, type DWClientDownStream, TOPIC_ROBOT } from "dingtalk-stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { parseBuiltInCommand, renderBuiltInHelp } from "./commands.js";
import * as log from "./log.js";
import { isRecord } from "./shared/type-guards.js";

// ============================================================================
// Types
// ============================================================================

export interface DingTalkConfig {
	clientId: string;
	clientSecret: string;
	robotCode?: string;
	cardTemplateId?: string;
	cardTemplateKey?: string;
	allowFrom?: string[];
	stateDir?: string;
}

export interface DingTalkEvent {
	type: "dm" | "group";
	channelId: string; // dm_{staffId} or group_{conversationId}
	ts: string;
	user: string; // sender staff id
	userName: string; // sender nickname
	text: string;
	conversationId: string;
	conversationType: string; // "1" = DM, "2" = group
}

export interface DingTalkContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
	};
	channelName?: string;
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	respondPlain: (text: string, shouldLog?: boolean) => Promise<boolean>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
	flush: () => Promise<void>;
	close: () => Promise<void>;
}

export type BusyMessageMode = "steer" | "followUp";

export interface DingTalkHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: DingTalkEvent, bot: DingTalkBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, bot: DingTalkBot): Promise<void>;
	handleBusyMessage(event: DingTalkEvent, bot: DingTalkBot, mode: BusyMessageMode, queueText: string): Promise<void>;
}

// ============================================================================
// AI Card State
// ============================================================================

interface AICard {
	instanceId: string;
	conversationId: string;
	accessToken: string;
	templateKey: string;
	createdAt: number;
	lastUpdated: number;
	content: string;
	finished: boolean;
}

interface ConversationMeta {
	conversationId: string;
	conversationType: string;
	senderId: string;
}

interface DingTalkIncomingMessage {
	msgId?: string;
	senderStaffId?: string;
	senderId?: string;
	senderNick?: string;
	conversationId?: string;
	conversationType?: string;
	msgtype?: string;
	text?: {
		content?: string;
	};
	content?: {
		richText?: Array<Record<string, string>>;
	};
}

interface DingTalkSocketLike {
	readyState?: number;
	ping?: () => void;
	on(event: "pong", listener: () => void): void;
	on(event: "close", listener: (code: number, reason: string) => void): void;
	on(event: "message", listener: (raw: string) => void): void;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;
	private stopped = false;

	enqueue(work: QueuedWork): void {
		if (this.stopped) return;
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.stopped || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}

	stop(): void {
		this.stopped = true;
		this.queue = [];
	}
}

// ============================================================================
// Constants
// ============================================================================

const DINGTALK_API = "https://api.dingtalk.com";
const TOKEN_REFRESH_SECS = 90 * 60; // 1.5 hours (tokens expire after 2 hours)

// ============================================================================
// DingTalkBot
// ============================================================================

export class DingTalkBot {
	private handler: DingTalkHandler;
	private config: DingTalkConfig;

	// Access token cache
	private accessToken: string | null = null;
	private tokenExpiry = 0;
	private tokenRefreshPromise: Promise<string | null> | null = null;

	// Active AI cards: channelId → AICard
	private activeCards = new Map<string, AICard>();

	// Conversation metadata cache: channelId → metadata
	private convMeta = new Map<string, ConversationMeta>();

	// Per-channel queues
	private queues = new Map<string, ChannelQueue>();

	// Connection stability
	private client: DWClient | null = null;
	private lastSocketAvailableTime = Date.now();
	private activeMessageProcessing = false;
	private keepAliveTimer: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	private isReconnecting = false;
	private isStopped = false;
	private reconnectAttempts = 0;

	// Deduplication cache (Set for O(1) lookup, order array for FIFO eviction)
	private processedIds = new Set<string>();
	private processedIdsOrder: string[] = [];

	constructor(handler: DingTalkHandler, config: DingTalkConfig) {
		this.handler = handler;
		this.config = config;
	}

	/**
	 * Mark an ID as processed. Returns true if this is a new ID, false if already seen.
	 * Maintains a FIFO buffer of at most 200 entries.
	 */
	private markProcessed(id: string): boolean {
		if (this.processedIds.has(id)) return false;
		this.processedIds.add(id);
		this.processedIdsOrder.push(id);
		while (this.processedIdsOrder.length > 200) {
			this.processedIds.delete(this.processedIdsOrder.shift()!);
		}
		return true;
	}

	private getSocket(): DingTalkSocketLike | null {
		if (!this.client) {
			return null;
		}
		const socket = Reflect.get(this.client as object, "socket");
		return this.isSocketLike(socket) ? socket : null;
	}

	private isSocketLike(value: unknown): value is DingTalkSocketLike {
		return isRecord(value) && typeof value.on === "function";
	}

	private setTrackedTimeout(callback: () => void, delayMs: number): NodeJS.Timeout {
		const timer = setTimeout(() => {
			callback();
		}, delayMs);
		timer.unref?.();
		return timer;
	}

	private setTrackedInterval(callback: () => void, intervalMs: number): NodeJS.Timeout {
		const timer = setInterval(callback, intervalMs);
		timer.unref?.();
		return timer;
	}

	private clearKeepAliveTimer(): void {
		if (this.keepAliveTimer) {
			clearInterval(this.keepAliveTimer);
			this.keepAliveTimer = null;
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private clearAllTimers(): void {
		this.clearKeepAliveTimer();
		this.clearReconnectTimer();
	}

	private async waitForDelay(delayMs: number): Promise<void> {
		await new Promise<void>((resolve) => {
			this.reconnectTimer = this.setTrackedTimeout(() => {
				this.reconnectTimer = null;
				resolve();
			}, delayMs);
		});
	}

	private scheduleReconnect(delayMs: number, immediate: boolean): void {
		if (this.isStopped) {
			return;
		}
		this.clearReconnectTimer();
		this.reconnectTimer = this.setTrackedTimeout(() => {
			this.reconnectTimer = null;
			this.doReconnect(immediate).catch((err) => {
				log.logWarning("DingTalk: reconnect failed", err instanceof Error ? err.message : String(err));
			});
		}, delayMs);
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		if (!this.config.clientId || !this.config.clientSecret) {
			log.logWarning("DingTalk: clientId / clientSecret not configured");
			return;
		}

		if (!this.config.cardTemplateId) {
			log.logWarning("DingTalk: cardTemplateId not configured — AI Card streaming will not work");
		}

		log.logInfo(`DingTalk: initializing stream (clientId=${this.config.clientId.substring(0, 8)}…)`);

		if (process.env.DINGTALK_FORCE_PROXY !== "true") {
			axios.defaults.proxy = false;
		}
		this.clearAllTimers();

		this.client = new DWClient({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
			keepAlive: false,
		});

		this.client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
			return this.handleRawMessage(msg);
		});

		log.logConnected();
		await this.doReconnect(true); // Initial connection
	}

	private handleRawMessage(msg: DWClientDownStream): { status: "SUCCESS"; message: string } {
		// 1. Immediate ACK
		if (msg.headers?.messageId && this.client) {
			this.client.socketCallBackResponse(msg.headers.messageId, { status: "SUCCESS", message: "OK" });
		}

		// 2. Protocol deduplication
		const messageId = msg.headers?.messageId;
		if (messageId && !this.markProcessed(messageId)) {
			return { status: "SUCCESS", message: "OK" };
		}

		try {
			const parsedData = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
			const data: DingTalkIncomingMessage = isRecord(parsedData) ? parsedData : {};

			// 3. Business logic deduplication
			const msgId = data.msgId;
			if (msgId && !this.markProcessed(msgId)) {
				return { status: "SUCCESS", message: "OK" };
			}

			// Fire-and-forget processing
			this.onStreamMessage(data).catch((err: unknown) => {
				log.logWarning("DingTalk handler error", err instanceof Error ? err.message : String(err));
			});
		} catch (err) {
			log.logWarning("DingTalk: failed to parse message", err instanceof Error ? err.message : String(err));
		}

		return { status: "SUCCESS", message: "OK" };
	}

	private async doReconnect(immediate = false) {
		if (this.isReconnecting || this.isStopped || !this.client) return;
		this.isReconnecting = true;
		let connectionFailed = false;

		if (!immediate && this.reconnectAttempts > 0) {
			const delay = Math.min(1000 * 2 ** this.reconnectAttempts + Math.random() * 1000, 30000);
			log.logInfo(`DingTalk: waiting ${Math.round(delay / 1000)}s before reconnecting...`);
			await this.waitForDelay(delay);
			if (this.isStopped || !this.client) {
				this.isReconnecting = false;
				return;
			}
		}

		try {
			const socket = this.getSocket();
			if (socket?.readyState === 1 || socket?.readyState === 3) {
				await Promise.resolve(this.client.disconnect());
			}

			await this.client.connect();

			this.lastSocketAvailableTime = Date.now();
			this.reconnectAttempts = 0; // Success, reset backoff
			log.logInfo("DingTalk: connected to stream.");

			// Setup keep alive
			this.clearKeepAliveTimer();
			this.keepAliveTimer = this.setTrackedInterval(() => {
				if (this.isStopped) return;

				const elapsed = Date.now() - this.lastSocketAvailableTime;
				if (elapsed > 90 * 1000 && !this.activeMessageProcessing) {
					log.logWarning("DingTalk: connection timeout detected (>90s). Keeping active where possible...");
				}

				try {
					const s = this.getSocket();
					if (s?.readyState === 1) {
						s.ping?.();
					}
				} catch (_err) {
					// Ignore
				}
			}, 30 * 1000);

			// Setup native socket events
			const s = this.getSocket();

			s?.on("pong", () => {
				this.lastSocketAvailableTime = Date.now();
			});

			s?.on("close", (code: number, reason: string) => {
				log.logWarning(`DingTalk: WebSocket closed: code=${code}, reason=${reason}`);
				if (this.isStopped) return;
				this.scheduleReconnect(1000, true);
			});

			s?.on("message", (raw: string) => {
				try {
					const msg = JSON.parse(raw);
					if (msg.type === "SYSTEM" && msg.headers?.topic === "disconnect") {
						log.logWarning("DingTalk: disconnect event received from server.");
						if (!this.isStopped) {
							this.doReconnect(true).catch(() => {});
						}
					}
				} catch (_e) {
					// skip
				}
			});
		} catch (err) {
			this.reconnectAttempts++;
			connectionFailed = true;
			log.logWarning("DingTalk: connection failed", err instanceof Error ? err.message : String(err));
		} finally {
			this.isReconnecting = false;
		}

		// Auto-retry on failure with exponential backoff
		if (connectionFailed && !this.isStopped) {
			this.scheduleReconnect(0, false);
		}
	}

	async stop(): Promise<void> {
		log.logInfo("DingTalk: stopping bot");
		this.isStopped = true;
		this.clearAllTimers();
		for (const queue of this.queues.values()) {
			queue.stop();
		}
		if (this.client) {
			try {
				await Promise.resolve(this.client.disconnect());
			} catch (err) {
				log.logWarning("DingTalk: failed to disconnect cleanly", err instanceof Error ? err.message : String(err));
			} finally {
				this.client = null;
			}
		}
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
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channelId}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channelId}: ${event.text.substring(0, 50)}`);
		queue.enqueue(async () => {
			this.activeMessageProcessing = true;
			try {
				await this.handler.handleEvent(event, this, true);
			} finally {
				this.activeMessageProcessing = false;
				this.lastSocketAvailableTime = Date.now();
			}
		});
		return true;
	}

	// ==========================================================================
	// AI Card operations
	// ==========================================================================

	/**
	 * Get or create an AI Card for a channel.
	 */
	async ensureCard(channelId: string): Promise<void> {
		if (!this.config.cardTemplateId) return;
		const existing = this.activeCards.get(channelId);
		if (existing && !existing.finished) return;
		await this.createCard(channelId);
	}

	/**
	 * Stream content to the active AI Card for a channel.
	 */
	async streamToCard(channelId: string, content: string, finalize: boolean = false): Promise<boolean> {
		let card = this.activeCards.get(channelId);
		if ((!card || card.finished) && !finalize && this.config.cardTemplateId && content.trim()) {
			await this.ensureCard(channelId);
			card = this.activeCards.get(channelId);
		}
		if (!card || card.finished) {
			if (finalize) {
				return this.sendPlain(channelId, content);
			}
			return false;
		}
		const streamed = await this.streamCard(card, content, finalize);
		if (!streamed) {
			this.activeCards.delete(channelId);
		}
		return streamed;
	}

	/**
	 * Finalize the active card for a channel without falling back to a plain message.
	 * Returns true if a card was finalized, false if no active card existed.
	 */
	async finalizeExistingCard(channelId: string, content: string): Promise<boolean> {
		let card = this.activeCards.get(channelId);
		if ((!card || card.finished) && this.config.cardTemplateId && content.trim()) {
			await this.ensureCard(channelId);
			card = this.activeCards.get(channelId);
		}
		if (!card || card.finished) {
			return false;
		}

		const finalized = await this.streamCard(card, content, true);
		this.activeCards.delete(channelId);
		return finalized;
	}

	/**
	 * Finalize and remove the active card for a channel.
	 */
	async finalizeCard(channelId: string, content: string): Promise<boolean> {
		const finalized = await this.finalizeExistingCard(channelId, content);
		if (!finalized) {
			return this.sendPlain(channelId, content);
		}
		return true;
	}

	discardCard(channelId: string): void {
		this.activeCards.delete(channelId);
	}

	/**
	 * Send a normal message natively mapping DM and Group to correct endpoints (fallback when no card).
	 */
	async sendPlain(channelId: string, text: string): Promise<boolean> {
		const token = await this.getAccessToken();
		if (!token) return false;

		const meta = this.getConversationMeta(channelId);
		if (!meta) {
			log.logWarning(`No conversation metadata for ${channelId}, cannot send plain message`);
			return false;
		}

		const robotCode = this.config.robotCode || this.config.clientId;
		const isGroup = meta.conversationType === "2";

		const hasMarkdown = /^#{1,6}\s|^\s*[-*]\s|\*\*.*\*\*|```|`[^`]+`|\[.*?\]\(.*?\)/m.test(text);

		const msgKey = hasMarkdown ? "sampleMarkdown" : "sampleText";
		const msgParam = hasMarkdown ? JSON.stringify({ text, title: "Bot" }) : JSON.stringify({ content: text });

		const url = isGroup
			? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
			: `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

		const body: any = {
			robotCode,
			msgKey,
			msgParam,
		};

		if (isGroup) {
			body.openConversationId = meta.conversationId;
		} else {
			body.userIds = [meta.senderId];
		}

		try {
			await axios.post(url, body, {
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
			});
			return true;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarning(`DingTalk plain send failed (${err.response.status})`, JSON.stringify(err.response.data));
			} else {
				log.logWarning("DingTalk plain send error", err instanceof Error ? err.message : String(err));
			}
			return false;
		}
	}

	// ==========================================================================
	// Private - AI Card implementation
	// ==========================================================================

	private async createCard(channelId: string): Promise<AICard | null> {
		const token = await this.getAccessToken();
		if (!token) return null;

		const meta = this.getConversationMeta(channelId);
		if (!meta) {
			log.logWarning(`No conversation metadata for ${channelId}, cannot create card`);
			return null;
		}

		const isGroup = meta.conversationType === "2";
		const instanceId = `card_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const robotCode = this.config.robotCode || this.config.clientId;

		// openSpaceId format:
		//   群聊: dtv1.card//IM_GROUP.{openConversationId}
		//   单聊: dtv1.card//IM_ROBOT.{userId}
		const openSpaceId = isGroup
			? `dtv1.card//IM_GROUP.${meta.conversationId}`
			: `dtv1.card//IM_ROBOT.${meta.senderId}`;

		const body: Record<string, unknown> = {
			cardTemplateId: this.config.cardTemplateId,
			outTrackId: instanceId,
			cardData: { cardParamMap: {} },
			callbackType: "STREAM",
			imGroupOpenSpaceModel: { supportForward: true },
			imRobotOpenSpaceModel: { supportForward: true },
			openSpaceId,
			userIdType: 1,
		};

		if (isGroup) {
			body.imGroupOpenDeliverModel = { robotCode };
		} else {
			body.imRobotOpenDeliverModel = { spaceType: "IM_ROBOT" };
		}

		try {
			await axios.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
			});
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarning(`DingTalk Card: create failed (${err.response.status})`, JSON.stringify(err.response.data));
			} else {
				log.logWarning("DingTalk Card: create failed", err instanceof Error ? err.message : String(err));
			}
			return null;
		}

		const card: AICard = {
			instanceId,
			conversationId: meta.conversationId,
			accessToken: token,
			templateKey: this.config.cardTemplateKey || "content",
			createdAt: Date.now() / 1000,
			lastUpdated: Date.now() / 1000,
			content: "",
			finished: false,
		};
		this.activeCards.set(channelId, card);
		return card;
	}

	private async streamCard(card: AICard, content: string, finalize: boolean = false): Promise<boolean> {
		// Refresh token if needed
		const ageSecs = Date.now() / 1000 - card.createdAt;
		if (ageSecs > TOKEN_REFRESH_SECS) {
			const token = await this.getAccessToken();
			if (token) {
				card.accessToken = token;
			}
		}

		const body = {
			outTrackId: card.instanceId,
			guid: `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			key: card.templateKey,
			content,
			isFull: true,
			isFinalize: finalize,
			isError: false,
		};

		const start = Date.now();
		try {
			await axios.put(`${DINGTALK_API}/v1.0/card/streaming`, body, {
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
			});

			const duration = Date.now() - start;
			if (duration > 1000) {
				log.logWarning(`DingTalk Card: streaming request took ${duration}ms (slow)`);
			}

			card.lastUpdated = Date.now() / 1000;
			card.content = content;
			if (finalize) {
				card.finished = true;
			}
			return true;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarning(
					`DingTalk Card: streaming failed (${err.response.status})`,
					JSON.stringify(err.response.data),
				);
			} else {
				log.logWarning("DingTalk Card: streaming failed", err instanceof Error ? err.message : String(err));
			}
			return false;
		}
	}

	// ==========================================================================
	// Private - Access Token
	// ==========================================================================

	private async getAccessToken(): Promise<string | null> {
		if (this.accessToken && Date.now() / 1000 < this.tokenExpiry) {
			return this.accessToken;
		}

		// Coalesce concurrent refresh requests into a single HTTP call
		if (!this.tokenRefreshPromise) {
			this.tokenRefreshPromise = this.refreshAccessToken().finally(() => {
				this.tokenRefreshPromise = null;
			});
		}
		return this.tokenRefreshPromise;
	}

	private async refreshAccessToken(): Promise<string | null> {
		try {
			const resp = await axios.post(
				`${DINGTALK_API}/v1.0/oauth2/accessToken`,
				{
					appKey: this.config.clientId,
					appSecret: this.config.clientSecret,
				},
				{
					headers: { "Content-Type": "application/json" },
				},
			);

			const data = resp.data as { accessToken?: string; expireIn?: number };
			this.accessToken = data.accessToken || null;
			this.tokenExpiry = Date.now() / 1000 + (data.expireIn || 7200) - 60;
			return this.accessToken;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarning(
					`DingTalk: failed to get access token (${err.response.status})`,
					JSON.stringify(err.response.data),
				);
			} else {
				log.logWarning("DingTalk: failed to get access token", err instanceof Error ? err.message : String(err));
			}
			return null;
		}
	}

	// ==========================================================================
	// Private - Message handling
	// ==========================================================================

	private extractContent(data: DingTalkIncomingMessage): string {
		// 1. text 类型消息：从 text.content 提取
		const textContent = (data.text?.content || "").trim();
		if (textContent) return textContent;

		// 2. richText 类型消息：从 content.richText 列表提取文本片段
		if (data.content?.richText) {
			const parts: string[] = [];
			for (const item of data.content.richText) {
				if (item.text) parts.push(item.text);
			}
			const joined = parts.join("").trim();
			if (joined) return joined;
		}

		return "";
	}

	private async onStreamMessage(data: DingTalkIncomingMessage): Promise<void> {
		if (this.isStopped) {
			return;
		}

		const content = this.extractContent(data);
		const senderId = data.senderStaffId || data.senderId || "";
		const senderName = data.senderNick || "Unknown";
		const conversationId = data.conversationId || "";
		const conversationType = data.conversationType || "1";

		if (!content) {
			const msgtype = typeof data.msgtype === "string" ? data.msgtype : "unknown";
			log.logWarning(`DingTalk: empty message (type=${msgtype})`);
			return;
		}

		if (this.config.allowFrom && this.config.allowFrom.length > 0) {
			if (!this.config.allowFrom.includes(senderId)) {
				log.logWarning(`DingTalk: ignoring message from unauthorized user ${senderName} (${senderId})`);
				return;
			}
		}

		// Determine channel ID
		const channelId = conversationType === "2" ? `group_${conversationId}` : `dm_${senderId}`;

		log.logInfo(`DingTalk ← ${senderName} (${senderId}) [${channelId}]: ${content.substring(0, 80)}`);

		// Cache conversation metadata for card creation
		this.setConversationMeta(channelId, {
			conversationId,
			conversationType,
			senderId,
		});

		// Build event
		const event: DingTalkEvent = {
			type: conversationType === "2" ? "group" : "dm",
			channelId,
			ts: Date.now().toString(),
			user: senderId,
			userName: senderName,
			text: content,
			conversationId,
			conversationType,
		};

		const builtInCommand = parseBuiltInCommand(content);
		const isSlashCommand = content.trim().startsWith("/");

		// Check if busy
		if (this.handler.isRunning(channelId)) {
			if (builtInCommand?.name === "help") {
				await this.sendPlain(channelId, renderBuiltInHelp());
				return;
			}

			if (builtInCommand?.name === "stop") {
				await this.handler.handleStop(channelId, this);
				await this.sendPlain(channelId, "Stopping the current task.");
				return;
			}

			if (builtInCommand?.name === "steer") {
				await this.handler.handleBusyMessage(event, this, "steer", builtInCommand.args);
				return;
			}

			if (builtInCommand?.name === "followup") {
				await this.handler.handleBusyMessage(event, this, "followUp", builtInCommand.args);
				return;
			}

			if (builtInCommand) {
				await this.sendPlain(
					channelId,
					"A task is already running. Use `/stop`, `/steer <message>`, or `/followup <message>`. Plain messages default to steer.",
				);
				return;
			}

			if (isSlashCommand) {
				await this.sendPlain(
					channelId,
					"A task is already running. Only `/stop`, `/steer <message>`, and `/followup <message>` are available while streaming.",
				);
				return;
			}

			await this.handler.handleBusyMessage(event, this, "steer", content);
			return;
		}

		// Enqueue for processing
		this.getQueue(channelId).enqueue(async () => {
			this.activeMessageProcessing = true;
			try {
				await this.handler.handleEvent(event, this);
			} finally {
				this.activeMessageProcessing = false;
				this.lastSocketAvailableTime = Date.now();
			}
		});
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private getConversationMeta(channelId: string): ConversationMeta | null {
		const cached = this.convMeta.get(channelId);
		if (cached) return cached;

		const metaPath = this.getConversationMetaPath(channelId);
		if (!metaPath || !existsSync(metaPath)) {
			return null;
		}

		try {
			const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as Partial<ConversationMeta>;
			if (!parsed.conversationId || !parsed.conversationType || !parsed.senderId) {
				return null;
			}

			const meta: ConversationMeta = {
				conversationId: parsed.conversationId,
				conversationType: parsed.conversationType,
				senderId: parsed.senderId,
			};
			this.convMeta.set(channelId, meta);
			return meta;
		} catch (err) {
			log.logWarning(
				`Failed to load conversation metadata for ${channelId}`,
				err instanceof Error ? err.message : String(err),
			);
			return null;
		}
	}

	private setConversationMeta(channelId: string, meta: ConversationMeta): void {
		this.convMeta.set(channelId, meta);

		const metaPath = this.getConversationMetaPath(channelId);
		if (!metaPath) return;

		try {
			mkdirSync(dirname(metaPath), { recursive: true });
			writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
		} catch (err) {
			log.logWarning(
				`Failed to persist conversation metadata for ${channelId}`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	private getConversationMetaPath(channelId: string): string | null {
		if (!this.config.stateDir) return null;
		return join(this.config.stateDir, channelId, ".channel-meta.json");
	}
}
