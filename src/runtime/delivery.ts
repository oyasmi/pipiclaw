import * as log from "../log.js";
import type { DingTalkBot, DingTalkContext, DingTalkEvent } from "./dingtalk.js";
import type { ChannelStore } from "./store.js";

const MIN_UPDATE_INTERVAL_MS = 800;
const ROLLING_WINDOW_SIZE = 3;
const NO_CONTENT = "";

type DeliveryMode = "progress" | "finalize-existing" | "finalize-with-fallback" | "silent";

class ChannelDeliveryController {
	private progressSegments: string[] = [];
	private cachedProgressText = "";
	private progressTextDirty = false;
	private mode: DeliveryMode = "progress";
	private desiredRevision = 0;
	private appliedRevision = 0;
	private running = false;
	private closed = false;
	private finalResponseDelivered = false;
	private cardWarmupScheduled = false;
	private cardWarmupTriggered = false;
	private progressStartedAt = 0;
	private progressWindowStartedAt = 0;
	private toolCallCount = 0;
	private lastDeliveredAt = 0;
	private timer: NodeJS.Timeout | null = null;
	private cardWarmupTimer: NodeJS.Timeout | null = null;
	private flushWaiters: Array<() => void> = [];
	private sentProgressChars = 0;
	private replayRequired = false;
	private finalReplacementText = "";

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
				if (!text.trim()) {
					return;
				}
				const delivered = await this.bot.sendPlain(this.event.channelId, text);
				if (!delivered) {
					log.logWarning(`[${this.event.channelId}] Failed to send light notice`, text.substring(0, 200));
				}
			},
			setTyping: async (_isTyping: boolean) => {},
			setWorking: async (_working: boolean) => {},
			deleteMessage: async () => this.silence(),
			primeCard: (delayMs: number) => this.primeCard(delayMs),
			flush: async () => this.flush(),
			close: async () => this.close(),
		};
	}

	private primeCard(delayMs: number): void {
		if (this.closed || this.finalResponseDelivered || this.cardWarmupScheduled || this.cardWarmupTriggered) {
			return;
		}

		this.cardWarmupScheduled = true;
		this.cardWarmupTimer = setTimeout(
			() => {
				this.cardWarmupScheduled = false;
				this.cardWarmupTimer = null;
				void this.triggerCardWarmup();
			},
			Math.max(0, delayMs),
		);
	}

	private async triggerCardWarmup(): Promise<void> {
		if (this.closed || this.finalResponseDelivered || this.desiredRevision > 0) {
			return;
		}

		this.cardWarmupTriggered = true;
		try {
			await this.bot.ensureCard(this.event.channelId);
		} catch (err) {
			log.logWarning(
				`[${this.event.channelId}] Failed to warm AI card`,
				err instanceof Error ? err.message : String(err),
			);
			this.bot.discardCard(this.event.channelId);
		}
	}

	private clearCardWarmup(): void {
		this.cardWarmupScheduled = false;
		if (this.cardWarmupTimer) {
			clearTimeout(this.cardWarmupTimer);
			this.cardWarmupTimer = null;
		}
	}

	private archiveBotResponse(text: string): void {
		void this.store.logBotResponse(this.event.channelId, text, Date.now().toString()).catch((err) => {
			log.logWarning(
				`[${this.event.channelId}] Failed to archive bot response`,
				err instanceof Error ? err.message : String(err),
			);
		});
	}

	private async appendProgress(text: string, shouldLog: boolean): Promise<void> {
		if (this.closed || this.finalResponseDelivered || !text.trim()) return;

		this.clearCardWarmup();
		if (this.progressStartedAt === 0) {
			this.progressStartedAt = Date.now();
		}
		if (text.startsWith("Running:")) {
			this.toolCallCount++;
		}
		if (this.progressSegments.length > 0) {
			this.progressSegments.push("\n\n");
		}
		this.progressSegments.push(text);
		this.progressTextDirty = true;
		if (this.bot.progressDisplay === "rolling") {
			this.trimToRecentEntries(ROLLING_WINDOW_SIZE);
		}
		if (this.progressWindowStartedAt === 0) {
			this.progressWindowStartedAt = Date.now();
		}
		if (shouldLog) {
			this.archiveBotResponse(text);
		}

		this.mode = "progress";
		this.bumpRevision(false);
	}

	private async sendFinal(text: string, shouldLog: boolean): Promise<boolean> {
		if (this.closed || this.finalResponseDelivered) return this.finalResponseDelivered;

		this.clearCardWarmup();
		if (shouldLog) {
			this.archiveBotResponse(text);
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

		this.clearCardWarmup();
		this.finalReplacementText = text;
		this.mode = "finalize-with-fallback";
		this.bumpRevision(true);
	}

	private async silence(): Promise<void> {
		if (this.closed) return;

		this.clearCardWarmup();
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
				const progressText = this.getProgressText();
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
				const content = progressText.trim();
				const replacementText = this.finalReplacementText;
				let touchedRemote = false;

				try {
					if (mode === "progress") {
						if (content) {
							const nextSentChars = progressText.length;
							if (this.replayRequired) {
								touchedRemote = await this.bot.replaceCard(this.event.channelId, progressText);
							} else {
								const delta = progressText.slice(this.sentProgressChars);
								touchedRemote = delta ? await this.bot.appendToCard(this.event.channelId, delta) : true;
							}
							if (!touchedRemote) {
								this.bot.discardCard(this.event.channelId);
								this.replayRequired = true;
							} else {
								this.sentProgressChars = nextSentChars;
								this.replayRequired = false;
							}
						}
					} else if (mode === "finalize-existing") {
						if (content || this.cardWarmupTriggered) {
							const finalProgressText =
								this.bot.progressDisplay === "rolling" ? this.buildSummaryText("Done") : progressText;
							touchedRemote = await this.bot.replaceCard(
								this.event.channelId,
								content || this.bot.progressDisplay === "rolling" ? finalProgressText : NO_CONTENT,
								true,
							);
							if (!touchedRemote) {
								this.bot.discardCard(this.event.channelId);
							} else {
								this.sentProgressChars = finalProgressText.length;
								this.replayRequired = false;
							}
						} else {
							this.bot.discardCard(this.event.channelId);
						}
					} else if (mode === "finalize-with-fallback") {
						if (replacementText.trim()) {
							touchedRemote = await this.bot.finalizeCard(this.event.channelId, replacementText);
							if (!touchedRemote) {
								this.bot.discardCard(this.event.channelId);
							}
						} else {
							this.bot.discardCard(this.event.channelId);
						}
					} else if (mode === "silent") {
						if (this.cardWarmupTriggered) {
							touchedRemote = await this.bot.replaceCard(this.event.channelId, NO_CONTENT, true);
						}
						if (!touchedRemote) {
							this.bot.discardCard(this.event.channelId);
						}
					}
				} catch (err) {
					log.logWarning(
						`[${this.event.channelId}] Delivery sync failed`,
						err instanceof Error ? err.message : String(err),
					);
					this.bot.discardCard(this.event.channelId);
					if (mode === "progress") {
						this.replayRequired = true;
					}
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
		this.clearCardWarmup();
		await this.flush();
	}

	private getProgressText(): string {
		if (!this.progressTextDirty) {
			return this.cachedProgressText;
		}

		this.cachedProgressText = this.progressSegments.join("");
		this.progressTextDirty = false;
		return this.cachedProgressText;
	}

	private trimToRecentEntries(maxEntries: number): void {
		let entryCount = 0;
		for (const segment of this.progressSegments) {
			if (segment !== "\n\n") {
				entryCount++;
			}
		}

		if (entryCount <= maxEntries) {
			return;
		}

		const entriesToRemove = entryCount - maxEntries;
		let removedEntries = 0;
		while (removedEntries < entriesToRemove && this.progressSegments.length > 0) {
			const segment = this.progressSegments.shift();
			if (segment !== "\n\n") {
				removedEntries++;
			}
		}
		while (this.progressSegments[0] === "\n\n") {
			this.progressSegments.shift();
		}

		this.progressTextDirty = true;
		this.replayRequired = true;
		this.sentProgressChars = 0;
	}

	private buildSummaryText(status: "Done"): string {
		const elapsedSeconds = this.progressStartedAt > 0 ? Math.round((Date.now() - this.progressStartedAt) / 1000) : 0;
		const toolLabel = this.toolCallCount === 1 ? "1 tool call" : `${this.toolCallCount} tool calls`;
		return `${status} · ${toolLabel} · ${elapsedSeconds}s`;
	}
}

export function createDingTalkContext(event: DingTalkEvent, bot: DingTalkBot, store: ChannelStore): DingTalkContext {
	return new ChannelDeliveryController(event, bot, store).buildContext();
}
