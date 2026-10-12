/**
 * The DingTalk Stream socket lifecycle: connect with a timeout, keep it alive, and reconnect with
 * exponential backoff. Owns the client, every timer and the reconnect state machine; it knows
 * nothing about messages beyond handing raw frames to the callback it was given.
 */
import { DWClient, type DWClientDownStream, TOPIC_ROBOT } from "dingtalk-stream";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { sleepUnref } from "../shared/with-timeout.js";

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

const CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;
const SOCKET_CLOSE_GRACE_MS = 1_000;
const SOCKET_TERMINATE_GRACE_MS = 250;
const SOCKET_STATE_CONNECTING = 0;
const SOCKET_STATE_OPEN = 1;
const SOCKET_STATE_CLOSING = 2;
const SOCKET_STATE_CLOSED = 3;

export interface StreamConnectionOptions {
	clientId: string;
	clientSecret: string;
	/** True once the bot is stopping: no further reconnects are scheduled. */
	isStopped: () => boolean;
	/** Handles one downstream robot frame; the ack to DingTalk is the callee's business. */
	onRawMessage: (msg: DWClientDownStream) => { status: "SUCCESS"; message: string };
}

export class StreamConnection {
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
	private isReconnecting = false;
	private reconnectAttempts = 0;
	private hasReportedReady = false;

	constructor(private options: StreamConnectionOptions) {}

	/** Create the client and make the first (immediate) connection attempt. */
	async start(): Promise<void> {
		this.clearAllTimers();

		const clientOptions = {
			clientId: this.options.clientId,
			clientSecret: this.options.clientSecret,
			autoReconnect: false,
			keepAlive: false,
		} as ConstructorParameters<typeof DWClient>[0] & { autoReconnect: boolean };

		this.client = new DWClient(clientOptions);

		this.client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
			return this.options.onRawMessage(msg);
		});

		const connected = await this.doReconnect(true); // Initial connection
		if (!connected) {
			log.logWarn("dingtalk.connect.pending", "Initial stream connection not ready; retrying in background");
		}
	}

	/** Acknowledge a downstream frame immediately so DingTalk does not redeliver it. */
	ack(messageId: string): void {
		this.client?.socketCallBackResponse(messageId, { status: "SUCCESS", message: "OK" });
	}

	/** A turn is running: the keep-alive watchdog must not treat the quiet socket as dead. */
	beginMessageProcessing(): void {
		this.activeMessageProcessing = true;
	}

	endMessageProcessing(): void {
		this.activeMessageProcessing = false;
		this.lastSocketAvailableTime = Date.now();
	}

	/** Cancel the keep-alive, scheduled-reconnect and backoff timers. */
	clearAllTimers(): void {
		this.clearKeepAliveTimer();
		this.clearReconnectTimer();
		this.clearReconnectDelay();
	}

	/** Close the socket and drop the client (the bot is stopping). */
	async disconnect(): Promise<void> {
		if (this.client) {
			try {
				await this.cleanupSocket("stop");
			} catch (err) {
				log.logWarn("dingtalk.disconnect.failed", "Clean disconnect failed", { reason: errorMessage(err) });
			} finally {
				this.client = null;
			}
		}
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
			await sleepUnref(25);
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
				log.logWarn("dingtalk.socket.close_failed", "Socket close failed", {
					reason: errorMessage(err),
					fields: { during: reason },
				});
			}

			const closed = await this.waitForSocketState(socket, SOCKET_STATE_CLOSED, SOCKET_CLOSE_GRACE_MS);
			if (!closed) {
				log.logWarn("dingtalk.socket.terminating", "Forcing socket termination", { fields: { during: reason } });
				try {
					socket.terminate?.();
				} catch (err) {
					log.logWarn("dingtalk.socket.terminate_failed", "Socket terminate failed", {
						reason: errorMessage(err),
						fields: { during: reason },
					});
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
		if (this.options.isStopped()) {
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
				log.logWarn("dingtalk.reconnect.failed", "Reconnect failed", { reason: errorMessage(err) });
			});
		}, delayMs);
	}

	private async doReconnect(immediate = false): Promise<boolean> {
		if (this.isReconnecting || this.options.isStopped() || !this.client) return false;
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
			if (this.options.isStopped() || !this.client) {
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
				if (this.options.isStopped()) return;

				const elapsed = Date.now() - this.lastSocketAvailableTime;
				if (elapsed > 90 * 1000 && !this.activeMessageProcessing) {
					// No pong / activity for >90s: the socket is (half-)dead and may
					// never emit a close event. Proactively force a reconnect instead
					// of waiting indefinitely. scheduleReconnect no-ops if an attempt
					// is already in flight or the bot has stopped.
					log.logWarn("dingtalk.connection.timeout", "Connection timeout (>90s); forcing reconnect");
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
				log.logWarn("dingtalk.socket.closed", "WebSocket closed", { fields: { code, reason } });
				if (this.options.isStopped()) return;
				this.scheduleReconnect(1000, true);
			});

			s?.on("message", (raw: string) => {
				try {
					const msg = JSON.parse(raw);
					if (msg.type === "SYSTEM" && msg.headers?.topic === "disconnect") {
						log.logWarn("dingtalk.connection.disconnected", "Server sent a disconnect event");
						if (!this.options.isStopped()) {
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
			log.logWarn("dingtalk.connect.failed", "Connection failed", { reason: errorMessage(err) });
		} finally {
			this.isReconnecting = false;
		}

		// Auto-retry on failure with exponential backoff
		if (connectionFailed && !this.options.isStopped()) {
			this.scheduleReconnect(0, false);
		}
		return connected;
	}
}
