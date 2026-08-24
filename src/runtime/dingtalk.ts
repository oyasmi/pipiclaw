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
import {
	formatBusyCommandList,
	parseBuiltInCommand,
	type RuntimeCommandName,
	renderBuiltInHelp,
	slashCommandName,
} from "../agent/commands.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
// The delivery contract (`ChannelContext`) and its traits are transport-neutral
// and live in channel-context.ts. Only the traits are used here, to map the
// DingTalk-config `ResponseMode` onto them (progressStyleOf/finalDeliveryOf).
import type { FinalDelivery, MediaSender, MediaSendResult, OutboundMedia, ProgressStyle } from "./channel-context.js";
import type { ChannelEvent } from "./channel-event.js";
import type { ChannelObservation } from "./channel-index.js";
import { getChannelDir } from "./channel-paths.js";
// Turn serialization is runtime policy; the queue lives in its own module and
// this transport only consumes it.
import { ChannelQueue } from "./channel-queue.js";

// ============================================================================
// Types
// ============================================================================

export type BusyMessageMode = "steer" | "followUp";
export type BusyMessageDefaultConfig = BusyMessageMode | "followup";
export type ResponseMode = "full_progress_then_plain_final" | "rolling_progress_then_plain_final" | "final_card_only";

const RESPONSE_MODE_VALUES: ResponseMode[] = [
	"full_progress_then_plain_final",
	"rolling_progress_then_plain_final",
	"final_card_only",
];

export function progressStyleOf(mode: ResponseMode): ProgressStyle {
	if (mode === "final_card_only") return "none";
	if (mode === "rolling_progress_then_plain_final") return "rolling";
	return "full";
}

export function finalDeliveryOf(mode: ResponseMode): FinalDelivery {
	return mode === "final_card_only" ? "card" : "plain";
}

export function isBusyMessageDefaultConfig(value: unknown): value is BusyMessageDefaultConfig {
	return value === "steer" || value === "followUp" || value === "followup";
}

export function isResponseModeConfig(value: unknown): value is ResponseMode {
	return typeof value === "string" && (RESPONSE_MODE_VALUES as string[]).includes(value);
}

export function normalizeBusyMessageDefault(value: unknown): BusyMessageMode {
	if (value === undefined) {
		return "steer";
	}
	if (value === "steer") {
		return "steer";
	}
	if (value === "followUp" || value === "followup") {
		return "followUp";
	}
	throw new Error('Invalid `busyMessageDefault`: expected "steer", "followUp", or "followup".');
}

export function normalizeResponseMode(value: unknown): ResponseMode {
	if (value === undefined) {
		return "full_progress_then_plain_final";
	}
	if (isResponseModeConfig(value)) {
		return value;
	}
	throw new Error(
		'Invalid `responseMode`: expected "full_progress_then_plain_final", "rolling_progress_then_plain_final", or "final_card_only".',
	);
}

/** Lowercased extension without the dot ("Report.PDF" → "pdf"); "" when none. */
function extractFileExtension(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	if (dot < 0 || dot === fileName.length - 1) return "";
	return fileName.slice(dot + 1).toLowerCase();
}

export interface DingTalkConfig {
	clientId: string;
	clientSecret: string;
	robotCode?: string;
	cardTemplateId?: string;
	cardTemplateKey?: string;
	allowFrom?: string[];
	stateDir?: string;
	busyMessageDefault?: BusyMessageDefaultConfig;
	responseMode?: ResponseMode;
	cardAutoLayout?: boolean;
}

/**
 * `DingTalkEvent` is kept as the public name (spec 035 D4: `src/index.ts`'s barrel is a
 * compatibility promise, so exported names there stay stable). Internally the type now lives in
 * `channel-event.ts` as `ChannelEvent`: most producers of this shape are not DingTalk at all
 * (job-manager, task-driver, events, subagents/runs all synthesize wakes), so `ChannelEvent` is
 * what the rest of the runtime imports.
 */
export type DingTalkEvent = ChannelEvent;

export type BusyMessageResult = { kind: "handled" } | { kind: "requeue"; text: string };

/**
 * What `/stop` actually did. Stopping a task-driven turn also pauses that task, which the user
 * has to be told: a disabled task is never picked up again until `/tasks resume <id>`, so silence
 * here reads as "the turn was interrupted" while the whole task has in fact gone quiet.
 */
export interface StopOutcome {
	pausedTaskId?: string;
}

export interface DingTalkHandler {
	isRunning(channelId: string): boolean;
	/**
	 * Note that a real person just wrote in this channel. Called once per accepted inbound
	 * message, before any busy/command routing, and never for synthetic wakes — see the
	 * maintenance contract in `channel-index.ts`. Must stay synchronous and cheap.
	 */
	noteChannelActivity?(observation: ChannelObservation): void;
	/**
	 * Synchronously reserve an inbound turn before the queued async body yields.
	 * The transport calls this hook, when provided, immediately before `handleEvent`.
	 */
	reserveEvent?(event: DingTalkEvent): void;
	handleEvent(event: DingTalkEvent, bot: DingTalkBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, bot: DingTalkBot): Promise<StopOutcome>;
	/** `/new` bypasses the old per-channel queue and live SDK session. */
	handleNewSession(event: DingTalkEvent, bot: DingTalkBot): Promise<void>;
	/**
	 * Render one of the stateless report commands (events/tasks/status/usage/context/subagents) to
	 * text. Single dispatch point shared by the busy-turn switch below and bootstrap's idle-turn
	 * switch — both used to hand-copy the same six-case table.
	 */
	runRuntimeCommand(event: DingTalkEvent, name: RuntimeCommandName, args: string): Promise<string>;
	handleBusyMessage(
		event: DingTalkEvent,
		bot: DingTalkBot,
		mode: BusyMessageMode,
		queueText: string,
	): Promise<BusyMessageResult>;
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

interface CardStreamOptions {
	append: boolean;
	finalize: boolean;
	failed: boolean;
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
	/** Group title. Present on group messages only; DingTalk omits it for DMs. */
	conversationTitle?: string;
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
	close?: () => void;
	terminate?: () => void;
	removeAllListeners?: () => void;
	removeListener?: (event: "error", listener: (error: Error) => void) => void;
	on(event: "error", listener: (error: Error) => void): void;
	on(event: "pong", listener: () => void): void;
	on(event: "close", listener: (code: number, reason: string) => void): void;
	on(event: "message", listener: (raw: string) => void): void;
}

// ============================================================================
// Constants
// ============================================================================

const DINGTALK_API = "https://api.dingtalk.com";
// Media upload lives on the legacy oapi host, not the v1.0 api host. It returns a
// reusable `media_id` that the v1.0 robot send endpoints reference (photoURL /
// mediaId). The `access_token` query param is the same app access token minted by
// `/v1.0/oauth2/accessToken` — DingTalk unified the internal-app token across both
// hosts — so `getAccessToken()` is reused rather than fetching a second token.
const DINGTALK_OAPI = "https://oapi.dingtalk.com";
// DingTalk caps robot image messages at 1MB and file messages at 20MB. We reject
// oversized files before spending an upload round-trip on a request the API rejects.
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Uploads can move up to 20MB; the 15s default HTTP timeout is too tight for that.
const MEDIA_UPLOAD_TIMEOUT_MS = 60_000;
// File extensions the `sampleFile` message type accepts (per DingTalk docs).
const SUPPORTED_FILE_TYPES = new Set(["xlsx", "pdf", "zip", "rar", "doc", "docx", "ppt", "pptx", "csv", "txt"]);
// Bound every outbound DingTalk HTTP call. Without this, axios waits forever on a
// hung connection, and a stalled card-streaming request would wedge the delivery
// sync loop (never resolving flush()), leaving the whole channel permanently busy.
// A timeout turns "hang" into a normal failure that the existing fallback paths
// (discardCard / replay / sendPlain) already handle.
const DINGTALK_HTTP_TIMEOUT_MS = 15_000;
const http = axios.create({ timeout: DINGTALK_HTTP_TIMEOUT_MS });
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
const TOKEN_REFRESH_SECS = 90 * 60; // 1.5 hours (tokens expire after 2 hours)
const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;
const SOCKET_CLOSE_GRACE_MS = 1_000;
const SOCKET_TERMINATE_GRACE_MS = 250;
const SOCKET_STATE_CONNECTING = 0;
const SOCKET_STATE_OPEN = 1;
const SOCKET_STATE_CLOSING = 2;
const SOCKET_STATE_CLOSED = 3;

// ============================================================================
// DingTalkBot
// ============================================================================

export class DingTalkBot implements MediaSender {
	private handler: DingTalkHandler;
	private config: DingTalkConfig;

	// Access token cache
	private accessToken: string | null = null;
	private tokenExpiry = 0;
	private tokenRefreshPromise: Promise<string | null> | null = null;

	// Active AI cards: channelId → AICard
	private activeCards = new Map<string, AICard>();
	// Singleflight for card creation: warmup and the first progress update can
	// race before activeCards is populated, which would create two cards. Sharing
	// the in-flight promise per channel guarantees at most one create call.
	private cardCreationInFlight = new Map<string, Promise<AICard | null>>();

	// Conversation metadata cache: channelId → metadata
	private convMeta = new Map<string, ConversationMeta>();
	private channelLastActiveAt = new Map<string, number>();

	// Per-channel queues
	private queues = new Map<string, ChannelQueue>();

	// Connection stability
	private client: DWClient | null = null;
	private lastSocketAvailableTime = Date.now();
	private activeMessageProcessing = false;
	private keepAliveTimer: NodeJS.Timeout | null = null;
	private reconnectTimer: NodeJS.Timeout | null = null;
	// Dedicated timer for the in-flight backoff sleep inside doReconnect, kept
	// separate from reconnectTimer so an external scheduleReconnect() (e.g. a
	// WebSocket close event) can never clear the sleep out from under an active
	// attempt and leave isReconnecting stuck true forever.
	private reconnectDelayTimer: NodeJS.Timeout | null = null;
	private reconnectDelayResolve: (() => void) | null = null;
	private channelCacheSweepTimer: NodeJS.Timeout | null = null;
	private isReconnecting = false;
	private isStopped = false;
	private reconnectAttempts = 0;
	private hasReportedReady = false;

	// Deduplication cache (Set for O(1) lookup, order array for FIFO eviction)
	private processedIds = new Set<string>();
	private processedIdsOrder: string[] = [];

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
		if (!isRecord(value)) {
			return false;
		}
		return typeof value.on === "function";
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

	// Cancel the backoff sleep and resolve its pending promise so the awaiting
	// doReconnect unblocks (and then bails on the isStopped/!client re-check)
	// instead of hanging forever.
	private clearReconnectDelay(): void {
		if (this.reconnectDelayTimer) {
			clearTimeout(this.reconnectDelayTimer);
			this.reconnectDelayTimer = null;
		}
		if (this.reconnectDelayResolve) {
			const resolve = this.reconnectDelayResolve;
			this.reconnectDelayResolve = null;
			resolve();
		}
	}

	private clearAllTimers(): void {
		this.clearKeepAliveTimer();
		this.clearReconnectTimer();
		this.clearReconnectDelay();
	}

	private async sleep(delayMs: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, delayMs);
			timer.unref?.();
		});
	}

	private async waitForDelay(delayMs: number): Promise<void> {
		await new Promise<void>((resolve) => {
			this.reconnectDelayResolve = resolve;
			this.reconnectDelayTimer = this.setTrackedTimeout(() => {
				this.reconnectDelayTimer = null;
				this.reconnectDelayResolve = null;
				resolve();
			}, delayMs);
		});
	}

	private async waitForSocketState(
		socket: DingTalkSocketLike,
		expectedState: number,
		timeoutMs: number,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while ((socket.readyState ?? SOCKET_STATE_CLOSED) !== expectedState && Date.now() < deadline) {
			await this.sleep(25);
		}
		return (socket.readyState ?? SOCKET_STATE_CLOSED) === expectedState;
	}

	private markClientDisconnected(): void {
		if (!this.client) {
			return;
		}
		Reflect.set(this.client as object, "connected", false);
		Reflect.set(this.client as object, "registered", false);
		Reflect.set(this.client as object, "reconnecting", false);
	}

	private clearClientSocketReference(): void {
		if (!this.client) {
			return;
		}
		Reflect.set(this.client as object, "socket", undefined);
	}

	private async cleanupSocket(reason: string): Promise<void> {
		const socket = this.getSocket();
		this.markClientDisconnected();
		if (!socket) {
			this.clearClientSocketReference();
			return;
		}

		socket.removeAllListeners?.();
		// ws emits an asynchronous error when close() aborts a CONNECTING socket.
		const ignoreCleanupError = (): void => {};
		socket.on("error", ignoreCleanupError);

		if ((socket.readyState ?? SOCKET_STATE_CLOSED) !== SOCKET_STATE_CLOSED) {
			try {
				socket.close?.();
			} catch (err) {
				log.logWarning(`DingTalk: socket close failed during ${reason}`, errorMessage(err));
			}

			const closed = await this.waitForSocketState(socket, SOCKET_STATE_CLOSED, SOCKET_CLOSE_GRACE_MS);
			if (!closed) {
				log.logWarning(`DingTalk: forcing socket termination during ${reason}`);
				try {
					socket.terminate?.();
				} catch (err) {
					log.logWarning(`DingTalk: socket terminate failed during ${reason}`, errorMessage(err));
				}
				await this.waitForSocketState(socket, SOCKET_STATE_CLOSED, SOCKET_TERMINATE_GRACE_MS);
			}
		}

		if ((socket.readyState ?? SOCKET_STATE_CLOSED) === SOCKET_STATE_CLOSED) {
			socket.removeListener?.("error", ignoreCleanupError);
		}
		this.clearClientSocketReference();
	}

	private async connectWithTimeout(): Promise<void> {
		if (!this.client) {
			throw new Error("DingTalk client is not initialized");
		}

		const connectPromise = Promise.resolve(this.client.connect());
		let timeoutHandle: NodeJS.Timeout | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				reject(new Error(`connect timed out after ${CONNECT_ATTEMPT_TIMEOUT_MS}ms`));
			}, CONNECT_ATTEMPT_TIMEOUT_MS);
			timeoutHandle.unref?.();
		});

		try {
			await Promise.race([connectPromise, timeoutPromise]);
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}

		const socket = this.getSocket();
		if (!socket || socket.readyState !== SOCKET_STATE_OPEN) {
			throw new Error("stream socket did not reach open state");
		}
	}

	private scheduleReconnect(delayMs: number, immediate: boolean): void {
		if (this.isStopped) {
			return;
		}
		// An attempt is already in flight; it owns the retry loop and will
		// reschedule itself on failure. Scheduling here would be redundant and,
		// worse, tear down a just-established socket if the attempt has already
		// succeeded by the time this fires.
		if (this.isReconnecting) {
			return;
		}
		this.clearReconnectTimer();
		this.reconnectTimer = this.setTrackedTimeout(() => {
			this.reconnectTimer = null;
			this.doReconnect(immediate).catch((err) => {
				log.logWarning("DingTalk: reconnect failed", errorMessage(err));
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

		log.logEvent("info", "runtime.dingtalk.connecting", "Initializing stream client", {
			fields: { clientIdPrefix: this.config.clientId.substring(0, 8) },
		});

		this.clearAllTimers();

		const clientOptions = {
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
			autoReconnect: false,
			keepAlive: false,
		} as ConstructorParameters<typeof DWClient>[0] & { autoReconnect: boolean };

		this.client = new DWClient(clientOptions);

		this.client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
			return this.handleRawMessage(msg);
		});

		const connected = await this.doReconnect(true); // Initial connection
		if (!connected) {
			log.logWarning("DingTalk: initial stream connection not ready yet; retrying in background");
		}
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
				log.logWarning("DingTalk handler error", errorMessage(err));
			});
		} catch (err) {
			log.logWarning("DingTalk: failed to parse message", errorMessage(err));
		}

		return { status: "SUCCESS", message: "OK" };
	}

	private async doReconnect(immediate = false): Promise<boolean> {
		if (this.isReconnecting || this.isStopped || !this.client) return false;
		this.isReconnecting = true;
		let connectionFailed = false;
		let connected = false;
		this.clearReconnectTimer();
		this.clearKeepAliveTimer();

		if (!immediate && this.reconnectAttempts > 0) {
			const delay = Math.min(1000 * 2 ** this.reconnectAttempts + Math.random() * 1000, 30000);
			log.logEvent("info", "runtime.dingtalk.reconnect_scheduled", "Reconnect scheduled", {
				fields: { delayMs: delay },
			});
			await this.waitForDelay(delay);
			if (this.isStopped || !this.client) {
				this.isReconnecting = false;
				return false;
			}
		}

		try {
			const socket = this.getSocket();
			const readyState = socket?.readyState;
			if (
				readyState === SOCKET_STATE_CONNECTING ||
				readyState === SOCKET_STATE_OPEN ||
				readyState === SOCKET_STATE_CLOSING ||
				readyState === SOCKET_STATE_CLOSED
			) {
				await this.cleanupSocket("reconnect");
			}

			await this.connectWithTimeout();

			this.lastSocketAvailableTime = Date.now();
			this.reconnectAttempts = 0; // Success, reset backoff
			log.logEvent("info", "runtime.dingtalk.stream_connected", "Connected to stream");
			if (!this.hasReportedReady) {
				log.logConnected();
				this.hasReportedReady = true;
			}
			connected = true;

			// Setup keep alive
			this.clearKeepAliveTimer();
			this.keepAliveTimer = this.setTrackedInterval(() => {
				if (this.isStopped) return;

				const elapsed = Date.now() - this.lastSocketAvailableTime;
				if (elapsed > 90 * 1000 && !this.activeMessageProcessing) {
					// No pong / activity for >90s: the socket is (half-)dead and may
					// never emit a close event. Proactively force a reconnect instead
					// of waiting indefinitely. scheduleReconnect no-ops if an attempt
					// is already in flight or the bot has stopped.
					log.logWarning("DingTalk: connection timeout detected (>90s); forcing reconnect.");
					this.scheduleReconnect(1000, true);
					return;
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
			await this.cleanupSocket("reconnect failure");
			this.reconnectAttempts++;
			connectionFailed = true;
			log.logWarning("DingTalk: connection failed", errorMessage(err));
		} finally {
			this.isReconnecting = false;
		}

		// Auto-retry on failure with exponential backoff
		if (connectionFailed && !this.isStopped) {
			this.scheduleReconnect(0, false);
		}
		return connected;
	}

	async stop(): Promise<void> {
		log.logInfo("DingTalk: stopping bot");
		this.isStopped = true;
		this.clearAllTimers();
		if (this.channelCacheSweepTimer) {
			clearInterval(this.channelCacheSweepTimer);
			this.channelCacheSweepTimer = null;
		}
		for (const queue of this.queues.values()) {
			queue.stop();
		}
		if (this.client) {
			try {
				await this.cleanupSocket("stop");
			} catch (err) {
				log.logWarning("DingTalk: failed to disconnect cleanly", errorMessage(err));
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
			this.activeMessageProcessing = true;
			try {
				this.handler.reserveEvent?.(event);
				await this.handler.handleEvent(event, this, true);
			} finally {
				this.activeMessageProcessing = false;
				this.lastSocketAvailableTime = Date.now();
			}
		});
		return true;
	}

	private enqueueStreamMessage(event: DingTalkEvent, textOverride?: string): void {
		const queuedEvent = textOverride === undefined ? event : { ...event, text: textOverride };
		const queue = this.getQueue(event.channelId);
		if (queue.size() >= USER_MESSAGE_QUEUE_LIMIT) {
			log.logWarning(
				`Message queue full for ${event.channelId} (limit ${USER_MESSAGE_QUEUE_LIMIT}), discarding: ${queuedEvent.text.substring(0, 50)}`,
			);
			this.sendPlain(
				event.channelId,
				`⚠️ 消息积压过多（超过 ${USER_MESSAGE_QUEUE_LIMIT} 条待处理），本条消息已丢弃，请稍后重试。`,
			).catch(() => undefined);
			return;
		}
		queue.enqueue(async () => {
			this.activeMessageProcessing = true;
			try {
				this.handler.reserveEvent?.(queuedEvent);
				await this.handler.handleEvent(queuedEvent, this);
			} finally {
				this.activeMessageProcessing = false;
				this.lastSocketAvailableTime = Date.now();
			}
		});
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
	 * Replace the active card content with a full snapshot.
	 */
	async replaceCard(
		channelId: string,
		content: string,
		finalize: boolean = false,
		failed: boolean = false,
	): Promise<boolean> {
		let card = this.activeCards.get(channelId);
		if ((!card || card.finished) && this.config.cardTemplateId && (content.trim() || !finalize || failed)) {
			await this.ensureCard(channelId);
			card = this.activeCards.get(channelId);
		}
		if (!card || card.finished) {
			if (finalize && content.trim()) {
				return this.sendPlain(channelId, content);
			}
			return false;
		}
		const streamed = await this.streamCard(card, content, {
			append: false,
			finalize,
			failed,
		});
		if (!streamed || finalize || failed) {
			this.activeCards.delete(channelId);
		}
		return streamed;
	}

	/**
	 * Append a delta to the active card transcript.
	 */
	async appendToCard(
		channelId: string,
		content: string,
		finalize: boolean = false,
		failed: boolean = false,
	): Promise<boolean> {
		if (!content && !finalize && !failed) {
			return true;
		}

		let card = this.activeCards.get(channelId);
		if ((!card || card.finished) && !finalize && !failed && this.config.cardTemplateId && content.trim()) {
			await this.ensureCard(channelId);
			card = this.activeCards.get(channelId);
		}
		if (!card || card.finished) {
			if (finalize && content.trim()) {
				return this.sendPlain(channelId, content);
			}
			return false;
		}

		const streamed = await this.streamCard(card, content, {
			append: true,
			finalize,
			failed,
		});
		if (!streamed || finalize || failed) {
			this.activeCards.delete(channelId);
		}
		return streamed;
	}

	/**
	 * Finalize and remove the active card for a channel.
	 */
	async finalizeCard(channelId: string, content: string): Promise<boolean> {
		const finalized = await this.replaceCard(channelId, content, true, false);
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
		const meta = this.getConversationMeta(channelId);
		if (!meta) {
			log.logWarning(`No conversation metadata for ${channelId}, cannot send plain message`);
			return false;
		}

		const hasMarkdown = opts?.markdown ?? /^#{1,6}\s|^\s*[-*]\s|\*\*.*\*\*|```|`[^`]+`|\[.*?\]\(.*?\)/m.test(text);
		const title = opts?.title ?? "Bot";
		const msgKey = hasMarkdown ? "sampleMarkdown" : "sampleText";
		const msgParam = hasMarkdown ? JSON.stringify({ text, title }) : JSON.stringify({ content: text });

		return this.sendRobotMessage(meta, msgKey, msgParam);
	}

	// ==========================================================================
	// Media (image / file) delivery — MediaSender contract
	// ==========================================================================

	/**
	 * Deliver a local file to a channel as a native attachment. Uploads the bytes
	 * to get a `media_id`, then sends a `sampleImageMsg` (inline image) or
	 * `sampleFile` (downloadable file) robot message. `channelId` is supplied by
	 * the runtime (the tool is bound to its channel at build time), never by the
	 * model, so an agent cannot target a channel other than its own.
	 */
	async sendMedia(channelId: string, media: OutboundMedia): Promise<MediaSendResult> {
		const isImage = media.kind === "image";
		const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
		if (media.data.length > limit) {
			return {
				ok: false,
				error: `File is ${(media.data.length / 1024 / 1024).toFixed(1)}MB, exceeds the ${limit / 1024 / 1024}MB DingTalk limit for ${media.kind} messages.`,
			};
		}

		const fileType = extractFileExtension(media.fileName);
		if (!isImage && !SUPPORTED_FILE_TYPES.has(fileType)) {
			return {
				ok: false,
				error: `DingTalk file messages do not support the "${fileType || "(none)"}" type. Supported: ${[...SUPPORTED_FILE_TYPES].join(", ")}.`,
			};
		}

		const meta = this.getConversationMeta(channelId);
		if (!meta) {
			return { ok: false, error: "No conversation is known for this channel yet; cannot deliver a file." };
		}

		const mediaId = await this.uploadMedia(isImage ? "image" : "file", media.data, media.fileName);
		if (!mediaId) {
			return { ok: false, error: "Failed to upload the file to DingTalk (see server logs)." };
		}

		const { msgKey, msgParam } = isImage
			? { msgKey: "sampleImageMsg", msgParam: JSON.stringify({ photoURL: mediaId }) }
			: {
					msgKey: "sampleFile",
					msgParam: JSON.stringify({ mediaId, fileName: media.fileName, fileType }),
				};

		const sent = await this.sendRobotMessage(meta, msgKey, msgParam);
		return sent ? { ok: true } : { ok: false, error: "DingTalk rejected the file message (see server logs)." };
	}

	/**
	 * Upload raw bytes to DingTalk and return the reusable `media_id`, or null on
	 * failure. The upload endpoint lives on the legacy oapi host and answers 200
	 * with a non-zero `errcode` on failure, so the body is inspected explicitly.
	 */
	private async uploadMedia(type: "image" | "file", data: Buffer, fileName: string): Promise<string | null> {
		const token = await this.getAccessToken();
		if (!token) return null;

		const form = new FormData();
		form.append("media", new Blob([new Uint8Array(data)]), fileName);

		try {
			const resp = await http.post(
				`${DINGTALK_OAPI}/media/upload?access_token=${encodeURIComponent(token)}&type=${type}`,
				form,
				// Override the 15s default: a multi-MB upload over a slow link can take
				// longer, and unlike card streaming this call is not on the delivery loop.
				{ timeout: MEDIA_UPLOAD_TIMEOUT_MS },
			);
			const body = isRecord(resp.data) ? resp.data : {};
			if (body.errcode && body.errcode !== 0) {
				log.logWarning(`DingTalk media upload failed (errcode=${body.errcode})`, String(body.errmsg ?? ""));
				return null;
			}
			const mediaId = typeof body.media_id === "string" ? body.media_id : null;
			if (!mediaId) {
				log.logWarning("DingTalk media upload returned no media_id", JSON.stringify(body));
			}
			return mediaId;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarning(`DingTalk media upload error (${err.response.status})`, JSON.stringify(err.response.data));
			} else {
				log.logWarning("DingTalk media upload error", errorMessage(err));
			}
			return null;
		}
	}

	/**
	 * POST a robot message with an arbitrary msgKey/msgParam, routing DM vs group
	 * to the correct endpoint. The single outbound path for every non-card message:
	 * plain text/markdown, images, and files.
	 */
	private async sendRobotMessage(meta: ConversationMeta, msgKey: string, msgParam: string): Promise<boolean> {
		const token = await this.getAccessToken();
		if (!token) return false;

		const robotCode = this.config.robotCode || this.config.clientId;
		const isGroup = meta.conversationType === "2";
		const url = isGroup
			? `${DINGTALK_API}/v1.0/robot/groupMessages/send`
			: `${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`;

		const body: Record<string, unknown> = { robotCode, msgKey, msgParam };
		if (isGroup) {
			body.openConversationId = meta.conversationId;
		} else {
			body.userIds = [meta.senderId];
		}

		try {
			await http.post(url, body, {
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
			});
			return true;
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarning(
					`DingTalk ${msgKey} send failed (${err.response.status})`,
					JSON.stringify(err.response.data),
				);
			} else {
				log.logWarning(`DingTalk ${msgKey} send error`, errorMessage(err));
			}
			return false;
		}
	}

	// ==========================================================================
	// Private - AI Card implementation
	// ==========================================================================

	private async createCard(channelId: string): Promise<AICard | null> {
		// Re-check under the singleflight: a concurrent caller may have already
		// created the card while we awaited, so avoid a duplicate create.
		const existing = this.activeCards.get(channelId);
		if (existing && !existing.finished) {
			return existing;
		}
		const inFlight = this.cardCreationInFlight.get(channelId);
		if (inFlight) {
			return inFlight;
		}
		const creation = this.createCardUncached(channelId).finally(() => {
			this.cardCreationInFlight.delete(channelId);
		});
		this.cardCreationInFlight.set(channelId, creation);
		return creation;
	}

	private async createCardUncached(channelId: string): Promise<AICard | null> {
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
			cardData: {
				cardParamMap: {
					sys_full_json_obj: JSON.stringify({
						config: {
							autoLayout: this.config.cardAutoLayout ?? true,
						},
					}),
				},
			},
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
			await http.post(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, body, {
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
			});
		} catch (err) {
			if (axios.isAxiosError(err) && err.response) {
				log.logWarning(`DingTalk Card: create failed (${err.response.status})`, JSON.stringify(err.response.data));
			} else {
				log.logWarning("DingTalk Card: create failed", errorMessage(err));
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

	private async streamCard(card: AICard, content: string, options: CardStreamOptions): Promise<boolean> {
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
			append: options.append,
			finished: options.finalize,
			failed: options.failed,
			isFull: !options.append,
			isFinalize: options.finalize,
			isError: options.failed,
		};

		const start = Date.now();
		try {
			await http.put(`${DINGTALK_API}/v1.0/card/streaming`, body, {
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
			card.content = options.append ? `${card.content}${content}` : content;
			if (options.finalize || options.failed) {
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
				log.logWarning("DingTalk Card: streaming failed", errorMessage(err));
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
			const resp = await http.post(
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
				log.logWarning("DingTalk: failed to get access token", errorMessage(err));
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

		log.logEvent("info", "runtime.dingtalk.message_received", "Accepted incoming message", {
			ctx: { channelId, userName: senderName },
			fields: { messageType: conversationType === "2" ? "group" : "dm", messageLength: content.length },
		});

		// A group carries its title on every message; a DM has none, so the peer's nickname is
		// the only human-readable handle that channel will ever have.
		const conversationTitle = typeof data.conversationTitle === "string" ? data.conversationTitle.trim() : "";
		const channelName = (conversationType === "2" ? conversationTitle : senderName) || undefined;

		// Cache conversation metadata for card creation
		this.setConversationMeta(channelId, {
			conversationId,
			conversationType,
			senderId,
		});

		// The one place a real person's message is seen before command/busy routing splits the
		// path, so the channel index counts every human message and no synthetic wake.
		this.handler.noteChannelActivity?.({ channelId, name: channelName, at: Date.now() });

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
			...(channelName ? { channelName } : {}),
		};

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
							log.logWarning(
								`[${channelId}] Failed to deliver /${builtInCommand.name} reply`,
								`${response.length} chars`,
							);
						}
						return;
					}
				}
			}

			// Other session commands (/model, /compact, …) and unknown slash commands cannot
			// run mid-turn: they would need the idle session layer.
			if (isSlashCommand) {
				await this.sendPlain(
					channelId,
					`当前已有回合在运行。运行中可用：${formatBusyCommandList()}。会话命令（\`/model\`、\`/compact\`、\`/session\`）需要等空闲后再用。`,
				);
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

	private getQueue(channelId: string): ChannelQueue {
		this.touchChannel(channelId);
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}

	private getConversationMeta(channelId: string): ConversationMeta | null {
		this.touchChannel(channelId);
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
			log.logWarning(`Failed to load conversation metadata for ${channelId}`, errorMessage(err));
			return null;
		}
	}

	private setConversationMeta(channelId: string, meta: ConversationMeta): void {
		this.touchChannel(channelId);
		this.convMeta.set(channelId, meta);

		const metaPath = this.getConversationMetaPath(channelId);
		if (!metaPath) return;

		try {
			mkdirSync(dirname(metaPath), { recursive: true });
			writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
		} catch (err) {
			log.logWarning(`Failed to persist conversation metadata for ${channelId}`, errorMessage(err));
		}
	}

	private getConversationMetaPath(channelId: string): string | null {
		if (!this.config.stateDir) return null;
		return join(getChannelDir(this.config.stateDir, channelId), ".channel-meta.json");
	}

	private touchChannel(channelId: string): void {
		this.channelLastActiveAt.set(channelId, Date.now());
	}

	private cleanupIdleChannelCaches(now = Date.now()): void {
		const cutoff = now - CHANNEL_CACHE_TTL_MS;
		for (const [channelId, lastActiveAt] of this.channelLastActiveAt) {
			if (lastActiveAt > cutoff) continue;
			const queue = this.queues.get(channelId);
			if (!queue?.isIdle() || this.cardCreationInFlight.has(channelId)) continue;

			const card = this.activeCards.get(channelId);
			if (card && card.lastUpdated * 1000 > cutoff) continue;
			this.activeCards.delete(channelId);
			this.convMeta.delete(channelId);
			this.queues.delete(channelId);
			this.channelLastActiveAt.delete(channelId);
		}
	}
}
