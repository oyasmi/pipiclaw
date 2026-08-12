import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import type { ChannelContext, ProgressStyle } from "./channel-context.js";
import type { ChannelEvent } from "./channel-event.js";
import type { DingTalkBot } from "./dingtalk.js";
import type { ChannelStore } from "./store.js";

const MIN_UPDATE_INTERVAL_MS = 800;
const ROLLING_WINDOW_SIZE = 3;
const NO_CONTENT = "";
// DingTalk's card renderer swallows a bare "\n" between plain lines (and a blank-line
// paragraph break leaves too much vertical gap), but it does reliably break a markdown
// list onto separate lines. Render each progress entry as a list item instead.
const PROGRESS_LINE_BREAK = "\n";
const PROGRESS_ENTRY_PREFIX = "- ";
// Last-resort ceiling on how long flush() will block a caller. Outbound HTTP now
// has its own timeout, so the sync loop is already bounded; this only guards against
// an unforeseen stall so run()'s finally can never hang the channel forever.
const FLUSH_DEADLINE_MS = 60_000;

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
		private event: ChannelEvent,
		private bot: DingTalkBot,
		private store: ChannelStore,
		/** Per-turn override of the channel's configured progress style; see `createDingTalkContext`. */
		private readonly progressStyleOverride?: ProgressStyle,
	) {}

	/** The style this turn actually delivers with: the override when present, else the channel's. */
	private get progressStyle(): ProgressStyle {
		return this.progressStyleOverride ?? this.bot.progressStyle;
	}

	buildContext(): ChannelContext {
		return {
			message: {
				text: this.event.text,
				rawText: this.event.text,
				user: this.event.user,
				userName: this.event.userName,
				channel: this.event.channelId,
				ts: this.event.ts,
			},
			// The group title when the transport supplied one; the raw id is the fallback so a
			// synthetic event (which carries no conversation payload) still names its channel.
			channelName: this.event.channelName ?? this.event.channelId,
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
			progressStyle: this.progressStyle,
			finalDelivery: this.bot.finalDelivery,
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
			log.logWarning(`[${this.event.channelId}] Failed to warm AI card`, errorMessage(err));
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
			log.logWarning(`[${this.event.channelId}] Failed to archive bot response`, errorMessage(err));
		});
	}

	private async appendProgress(text: string, shouldLog: boolean): Promise<void> {
		if (this.closed || this.finalResponseDelivered || !text.trim()) return;
		// Final-card-only mode shows no progress; ignore any stray progress writes
		// so we never create or flicker a card before the final replacement.
		if (this.progressStyle === "none") return;

		this.clearCardWarmup();
		if (this.progressStartedAt === 0) {
			this.progressStartedAt = Date.now();
		}
		if (text.startsWith("➜ ")) {
			this.toolCallCount++;
		}
		if (this.progressSegments.length > 0) {
			this.progressSegments.push(PROGRESS_LINE_BREAK);
		}
		this.progressSegments.push(`${PROGRESS_ENTRY_PREFIX}${text}`);
		this.progressTextDirty = true;
		if (this.progressStyle === "rolling") {
			this.trimToRecentEntries(ROLLING_WINDOW_SIZE);
			// The header carries elapsed time and a step count, so it changes on every update:
			// an append-only delta would leave a stale header on the card.
			this.replayRequired = true;
			this.sentProgressChars = 0;
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

		const delivered = await this.bot.sendPlain(this.event.channelId, text);
		if (!delivered) {
			// Do not archive a response we failed to deliver: the conversation log
			// must not claim we answered when the user never received it.
			return false;
		}

		if (shouldLog) {
			this.archiveBotResponse(text);
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
				const body = this.getProgressText();
				const progressText =
					mode === "progress" && this.progressStyle === "rolling" && body
						? `${this.buildRollingHeader()}\n\n${body}`
						: body;
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
							const isRolling = this.progressStyle === "rolling";
							const finalProgressText = isRolling ? this.buildSummaryText() : progressText;
							// A warmed-but-empty card in full mode has nothing to show, so it finalizes
							// blank; rolling mode always has its closing summary to put there.
							// (`||` binds tighter than `?:` — this used to read as one condition and
							// was a standing invitation to misparse it.)
							const finalCardText = content || isRolling ? finalProgressText : NO_CONTENT;
							touchedRemote = await this.bot.replaceCard(this.event.channelId, finalCardText, true);
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
					log.logWarning(`[${this.event.channelId}] Delivery sync failed`, errorMessage(err));
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
		let deadlineTimer: NodeJS.Timeout | null = null;
		await new Promise<void>((resolve) => {
			this.flushWaiters.push(resolve);
			deadlineTimer = setTimeout(() => {
				if (this.flushWaiters.includes(resolve)) {
					log.logWarning(
						`[${this.event.channelId}] Delivery flush deadline exceeded (${FLUSH_DEADLINE_MS}ms); releasing caller`,
					);
					this.flushWaiters = this.flushWaiters.filter((waiter) => waiter !== resolve);
					resolve();
				}
			}, FLUSH_DEADLINE_MS);
			deadlineTimer.unref?.();
		}).finally(() => {
			if (deadlineTimer) {
				clearTimeout(deadlineTimer);
			}
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

	private formatElapsed(ms: number): string {
		const seconds = Math.max(0, Math.round(ms / 1000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
		return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
	}

	private elapsedMs(): number {
		return this.progressStartedAt > 0 ? Date.now() - this.progressStartedAt : 0;
	}

	/**
	 * Standing first line for rolling mode. The window only keeps the last few entries, so a long
	 * turn otherwise gave no way to tell "still working, 14 steps in" from "stuck": every visible
	 * line looked the same as a minute ago. The numbers are already tracked for the closing summary.
	 */
	private buildRollingHeader(): string {
		return `⏱ ${this.formatElapsed(this.elapsedMs())} · ${this.toolCallCount} 步`;
	}

	private trimToRecentEntries(maxEntries: number): void {
		let entryCount = 0;
		for (const segment of this.progressSegments) {
			if (segment !== PROGRESS_LINE_BREAK) {
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
			if (segment !== PROGRESS_LINE_BREAK) {
				removedEntries++;
			}
		}
		while (this.progressSegments[0] === PROGRESS_LINE_BREAK) {
			this.progressSegments.shift();
		}

		this.progressTextDirty = true;
		this.replayRequired = true;
		this.sentProgressChars = 0;
	}

	private buildSummaryText(): string {
		return `完成 · ${this.toolCallCount} 步 · ${this.formatElapsed(this.elapsedMs())}`;
	}
}

/**
 * Build the delivery contract for one turn.
 *
 * `progressStyleOverride` lets the caller quiet a turn the user did not ask for. Background wakes
 * (task driver, finished jobs, scheduled events) pass `"none"`: without it every autonomous step
 * created an AI card in the human's conversation, streamed the model's thinking into it, and — for
 * the `[SILENT]` turns that are the *normal* outcome of a check-in — deleted the card again. The
 * final answer is unaffected; it is delivered by `respondPlain`/`replaceMessage` either way, so a
 * background turn that has something to say still says it.
 */
export function createDingTalkContext(
	event: ChannelEvent,
	bot: DingTalkBot,
	store: ChannelStore,
	progressStyleOverride?: ProgressStyle,
): ChannelContext {
	return new ChannelDeliveryController(event, bot, store, progressStyleOverride).buildContext();
}
