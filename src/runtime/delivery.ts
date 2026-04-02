import * as log from "../log.js";
import type { DingTalkBot, DingTalkContext, DingTalkEvent } from "./dingtalk.js";
import type { ChannelStore } from "./store.js";

const MIN_UPDATE_INTERVAL_MS = 800;

type DeliveryMode = "progress" | "finalize-existing" | "finalize-with-fallback" | "silent";

class ChannelDeliveryController {
	private progressText = "";
	private mode: DeliveryMode = "progress";
	private desiredRevision = 0;
	private appliedRevision = 0;
	private running = false;
	private closed = false;
	private finalResponseDelivered = false;
	private progressWindowStartedAt = 0;
	private lastDeliveredAt = 0;
	private timer: NodeJS.Timeout | null = null;
	private flushWaiters: Array<() => void> = [];

	constructor(
		private event: DingTalkEvent,
		private bot: DingTalkBot,
		private store: ChannelStore,
	) {}

	buildContext(): DingTalkContext {
		return {
			message: {
				text: this.event.text,
				rawText: this.event.text,
				user: this.event.user,
				userName: this.event.userName,
				channel: this.event.channelId,
				ts: this.event.ts,
			},
			channelName: this.event.channelId,
			respond: async (text: string, shouldLog = true) => this.appendProgress(text, shouldLog),
			respondPlain: async (text: string, shouldLog = true) => this.sendFinal(text, shouldLog),
			replaceMessage: async (text: string) => this.replaceWithFinal(text),
			respondInThread: async (text: string) => {
				log.logInfo(`[thread] ${text.substring(0, 200)}`);
			},
			setTyping: async (_isTyping: boolean) => {},
			setWorking: async (_working: boolean) => {},
			deleteMessage: async () => this.silence(),
			flush: async () => this.flush(),
			close: async () => this.close(),
		};
	}

	private async appendProgress(text: string, shouldLog: boolean): Promise<void> {
		if (this.closed || this.finalResponseDelivered || !text.trim()) return;

		this.progressText = this.progressText ? `${this.progressText}\n\n${text}` : text;
		if (this.progressWindowStartedAt === 0) {
			this.progressWindowStartedAt = Date.now();
		}
		if (shouldLog) {
			await this.store.logBotResponse(this.event.channelId, text, Date.now().toString());
		}

		this.mode = "progress";
		this.bumpRevision(false);
	}

	private async sendFinal(text: string, shouldLog: boolean): Promise<boolean> {
		if (this.closed || this.finalResponseDelivered) return this.finalResponseDelivered;

		if (shouldLog) {
			await this.store.logBotResponse(this.event.channelId, text, Date.now().toString());
		}

		const delivered = await this.bot.sendPlain(this.event.channelId, text);
		if (!delivered) {
			return false;
		}

		this.finalResponseDelivered = true;
		this.mode = "finalize-existing";
		this.bumpRevision(true);
		return true;
	}

	private async replaceWithFinal(text: string): Promise<void> {
		if (this.closed || this.finalResponseDelivered) return;

		this.progressText = text;
		this.mode = "finalize-with-fallback";
		this.bumpRevision(true);
	}

	private async silence(): Promise<void> {
		if (this.closed) return;

		this.finalResponseDelivered = true;
		this.mode = "silent";
		this.bumpRevision(true);
	}

	private bumpRevision(forceImmediate: boolean): void {
		this.desiredRevision++;
		this.schedule(forceImmediate);
	}

	private schedule(forceImmediate: boolean): void {
		if (this.running) return;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		const delay =
			forceImmediate || this.mode !== "progress"
				? 0
				: Math.max(
						0,
						MIN_UPDATE_INTERVAL_MS -
							(Date.now() - (this.lastDeliveredAt > 0 ? this.lastDeliveredAt : this.progressWindowStartedAt)),
					);

		if (delay === 0) {
			void this.runSyncLoop();
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = null;
			void this.runSyncLoop();
		}, delay);
	}

	private async runSyncLoop(): Promise<void> {
		if (this.running) return;
		this.running = true;

		try {
			while (this.appliedRevision < this.desiredRevision) {
				const mode = this.mode;
				const throttleBaseAt = this.lastDeliveredAt > 0 ? this.lastDeliveredAt : this.progressWindowStartedAt;
				if (mode === "progress" && throttleBaseAt > 0) {
					const remaining = MIN_UPDATE_INTERVAL_MS - (Date.now() - throttleBaseAt);
					if (remaining > 0) {
						this.timer = setTimeout(() => {
							this.timer = null;
							void this.runSyncLoop();
						}, remaining);
						return;
					}
				}

				const revision = this.desiredRevision;
				const content = this.progressText.trim();
				let touchedRemote = false;

				try {
					if (mode === "progress") {
						if (content) {
							touchedRemote = await this.bot.streamToCard(this.event.channelId, this.progressText);
							if (!touchedRemote) {
								this.bot.discardCard(this.event.channelId);
							}
						}
					} else if (mode === "finalize-existing") {
						if (content) {
							touchedRemote = await this.bot.finalizeExistingCard(this.event.channelId, this.progressText);
							if (!touchedRemote) {
								this.bot.discardCard(this.event.channelId);
							}
						} else {
							this.bot.discardCard(this.event.channelId);
						}
					} else if (mode === "finalize-with-fallback") {
						if (content) {
							touchedRemote = await this.bot.finalizeCard(this.event.channelId, this.progressText);
							if (!touchedRemote) {
								this.bot.discardCard(this.event.channelId);
							}
						} else {
							this.bot.discardCard(this.event.channelId);
						}
					} else if (mode === "silent") {
						this.bot.discardCard(this.event.channelId);
					}
				} catch (err) {
					log.logWarning(
						`[${this.event.channelId}] Delivery sync failed`,
						err instanceof Error ? err.message : String(err),
					);
					this.bot.discardCard(this.event.channelId);
				}

				if (touchedRemote) {
					this.lastDeliveredAt = Date.now();
				}
				if (mode !== "progress" || touchedRemote) {
					this.progressWindowStartedAt = 0;
				}
				this.appliedRevision = revision;
			}
		} finally {
			this.running = false;
			this.resolveFlushWaiters();

			if (this.appliedRevision < this.desiredRevision && !this.timer) {
				this.schedule(false);
			}
		}
	}

	private isSettled(): boolean {
		return !this.running && !this.timer && this.appliedRevision >= this.desiredRevision;
	}

	private resolveFlushWaiters(): void {
		if (!this.isSettled()) return;
		const waiters = this.flushWaiters;
		this.flushWaiters = [];
		for (const resolve of waiters) {
			resolve();
		}
	}

	private async flush(): Promise<void> {
		if (this.isSettled()) return;
		await new Promise<void>((resolve) => {
			this.flushWaiters.push(resolve);
		});
	}

	private async close(): Promise<void> {
		if (this.closed) {
			await this.flush();
			return;
		}

		this.closed = true;
		await this.flush();
	}
}

export function createDingTalkContext(event: DingTalkEvent, bot: DingTalkBot, store: ChannelStore): DingTalkContext {
	return new ChannelDeliveryController(event, bot, store).buildContext();
}
