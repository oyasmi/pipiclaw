/**
 * The DingTalk implementation of the turn output port (`ChannelContext`): it reads a turn's
 * structured events and renders them as AI-Card progress, plain messages and a final answer,
 * including the "card failed, send it plainly" fallbacks. Progress grows in a local window,
 * folds at its byte ceiling, and publishes paced deltas between replacement snapshots. The answer
 * is a normal message and the card then folds to one line.
 */
import type { ChannelContext, TurnEvent, TurnOutcome } from "../channel/channel-context.js";
import type { TurnInfo } from "../channel/transport.js";
import * as log from "../log.js";
import { formatElapsedZh } from "../shared/format.js";
import { errorMessage } from "../shared/text-utils.js";
import { describeToolCall } from "../tools/contract/presentation.js";
import { type ProgressActivity, ProgressWindow, type ProgressWrite, renderCardStatus } from "./progress.js";
import type { FinalDelivery, ProgressStyle } from "./response-mode.js";

/**
 * What a turn's delivery needs from the DingTalk side: the card surface and the plain-message
 * send. `DingTalkBot` implements it; the shape stays structural so this file does not import it.
 */
export interface DeliveryPort {
	readonly progressStyle: ProgressStyle;
	readonly finalDelivery: FinalDelivery;
	sendPlain(channelId: string, text: string, opts?: { title?: string; markdown?: boolean }): Promise<boolean>;
	getCardGeneration(channelId: string): symbol;
	isCardGenerationCurrent(channelId: string, generation: symbol): boolean;
	replaceCard(
		channelId: string,
		content: string,
		finalize?: boolean,
		failed?: boolean,
		generation?: symbol,
	): Promise<boolean>;
	appendToCard(
		channelId: string,
		content: string,
		finalize?: boolean,
		failed?: boolean,
		generation?: symbol,
	): Promise<boolean>;
	supportsStreamingAppend(): boolean;
	finalizeCard(channelId: string, content: string, generation?: symbol): Promise<boolean>;
	finalizeExistingCard(channelId: string, content: string, generation?: symbol): Promise<boolean>;
	discardCard(channelId: string, generation?: symbol): void;
}

/** Records a delivered answer in the channel's conversation log. */
export type ArchiveBotResponse = (channelId: string, text: string) => Promise<void>;

// A minimum gap after each completed write gives the client time to display a fold. This is
// a throttle, not a debounce: continuous events cannot postpone the next frame indefinitely.
const PROGRESS_INTERVAL_MS = 800;
const WAITING_TEXT = "正在处理…";
const MAX_PROGRESS_FAILURES = 2;
const SILENT_STATUS = "已处理，无需答复。";
// Last-resort ceiling on how long flush() will block a caller. Outbound HTTP now
// has its own timeout, so the sync loop is already bounded; this only guards against
// an unforeseen stall so run()'s finally can never hang the channel forever.
const FLUSH_DEADLINE_MS = 60_000;

type DeliveryMode = "progress" | "finalize-existing" | "finalize-with-fallback" | "silent";

class ChannelDeliveryController {
	private readonly progress: ProgressWindow;
	private nextProgressAt = 0;
	/** What the card shows after the waiting line has been replaced. Empty until the first real frame. */
	private document = "";
	private documentEpoch = -1;
	private mode: DeliveryMode = "progress";
	private desiredRevision = 0;
	private appliedRevision = 0;
	private running = false;
	private closed = false;
	private finalResponseDelivered = false;
	private ending = false;
	private progressFailures = 0;
	private readonly cardGeneration: symbol;
	private readonly progressStartedAt = Date.now();
	private toolCallCount = 0;
	private timer: NodeJS.Timeout | null = null;
	private flushWaiters: Array<() => void> = [];
	private finalReplacementText = "";

	/** Deliveries run one after another in the order the events arrived. */
	private chain: Promise<void> = Promise.resolve();
	private lastAnswer = "";
	private finished: Promise<void> | undefined;
	private readonly event: { channelId: string };

	constructor(
		turn: TurnInfo,
		private bot: DeliveryPort,
		private archive: ArchiveBotResponse,
		/** A quiet turn (a background wake) shows no progress, whatever the channel is configured for. */
		private readonly quiet: boolean,
	) {
		this.event = { channelId: turn.channelId };
		this.progress = new ProgressWindow(this.progressStyle === "rolling" ? "rolling" : "full");
		this.cardGeneration = bot.getCardGeneration(turn.channelId);
		// Start the waiting card in the same sync loop as progress and completion. Do not await
		// its HTTP request: the caller can start the model while card creation is in flight.
		if (this.progressStyle !== "none") this.bumpRevision(true);
	}

	private get isCurrent(): boolean {
		return this.bot.isCardGenerationCurrent(this.event.channelId, this.cardGeneration);
	}

	/** The style this turn actually delivers with. */
	private get progressStyle(): ProgressStyle {
		return this.quiet ? "none" : this.bot.progressStyle;
	}

	buildContext(): ChannelContext {
		return {
			emit: (event) => this.enqueue(() => this.deliver(event), event.type),
			finish: (outcome) => {
				// /stop and /new end the turn at once: the card is closed and this turn's later writes
				// are dropped now, not after whatever delivery is still in flight has finished.
				if (outcome.kind === "cancelled") {
					this.bot.discardCard(this.event.channelId, this.cardGeneration);
				}
				this.finished ??= this.enqueueFinish(outcome);
				return this.finished;
			},
		};
	}

	private enqueue(work: () => Promise<void>, context: string): void {
		this.chain = this.chain.then(async () => {
			try {
				await work();
			} catch (err) {
				log.logWarn("delivery.api.failed", "DingTalk API call failed", {
					reason: errorMessage(err),
					fields: { context },
				});
			}
		});
	}

	private async enqueueFinish(outcome: TurnOutcome): Promise<void> {
		this.enqueue(() => this.conclude(outcome), "finish");
		await this.chain;
	}

	/** Render one event; what the old pipeline did in its `respond*` calls, now chosen here. */
	private async deliver(event: TurnEvent): Promise<void> {
		switch (event.type) {
			case "tool.start":
				await this.remember(describeToolCall(event.tool, event.args), "➜", { countTool: true });
				return;
			case "tool.update":
				await this.remember(event.text, "➜");
				return;
			case "tool.end":
				if (event.failure) await this.remember(event.failure, "✕");
				return;
			case "reasoning":
				// Both modes record thinking chronologically; full retains the latest thought on a fold.
				await this.remember(event.text, "✦", { tail: true });
				return;
			case "commentary":
				await this.deliverCommentary(event.text, event.level);
				return;
			case "answer":
				await this.deliverAnswer(event.text);
				return;
			case "compaction":
				if (event.phase === "start") await this.remember("正在压缩上下文…", "");
				return;
			case "steer.applied":
				return;
		}
	}

	private async deliverCommentary(text: string, level: "error" | "warning" | "notice" | undefined): Promise<void> {
		switch (level) {
			case undefined:
				await this.remember(text, "");
				return;
			case "error":
				await this.remember(text, "✕");
				return;
			case "warning":
				if (this.progressStyle !== "none") {
					await this.remember(text, "✕");
				} else {
					await this.notice(`⚠️ ${text}`);
				}
				return;
			case "notice":
				await this.notice(text);
				return;
		}
	}

	private async deliverAnswer(text: string): Promise<void> {
		this.lastAnswer = text;
		if (this.bot.finalDelivery === "card") {
			await this.replaceWithFinal(text);
		} else {
			await this.sendFinal(text, true);
		}
	}

	/** A standalone side message: not part of the progress, sent even when progress is off. */
	private async notice(text: string): Promise<void> {
		if (this.closed || !this.isCurrent || !text.trim()) {
			return;
		}
		const delivered = await this.bot.sendPlain(this.event.channelId, text);
		if (!delivered) {
			log.logWarn("delivery.notice.failed", "Light notice delivery failed", {
				channelId: this.event.channelId,
				fields: { text: text.substring(0, 200) },
			});
		}
	}

	/**
	 * The turn's end: whatever it settled on is made visible (or cleaned up), then the card is
	 * closed. An answer that never reached the user gets one more try as a card.
	 */
	private async conclude(outcome: TurnOutcome): Promise<void> {
		try {
			switch (outcome.kind) {
				case "failed":
					try {
						await this.replaceWithFinal(outcome.message ?? "");
					} catch (err) {
						log.logWarn("delivery.error_reply.failed", "Error reply failed", {
							channelId: this.event.channelId,
							reason: errorMessage(err),
						});
					}
					break;
				case "silent":
					await this.silence();
					break;
				case "cancelled":
					await this.silence();
					break;
				case "completed":
					if (this.lastAnswer && !this.finalResponseDelivered) {
						try {
							await this.replaceWithFinal(this.lastAnswer);
						} catch (err) {
							log.logWarn("delivery.final_reply.failed", "Final reply replacement failed", {
								channelId: this.event.channelId,
								reason: errorMessage(err),
							});
						}
					}
					break;
			}
			await this.flush();
		} finally {
			await this.close();
		}
	}

	private archiveBotResponse(text: string): void {
		void this.archive(this.event.channelId, text).catch((err) => {
			log.logWarn("channel.archive.write_failed", "Bot response archive failed", {
				channelId: this.event.channelId,
				reason: errorMessage(err),
			});
		});
	}

	/**
	 * Record the latest desired view; bursts update it while one paced request publishes it.
	 */
	private async remember(
		text: string,
		marker: ProgressActivity["marker"],
		options?: { countTool?: boolean; tail?: boolean },
	): Promise<void> {
		if (this.closed || this.ending || !this.isCurrent || !text.trim()) return;
		// Final-card-only mode shows no progress; ignore any stray progress writes
		// so we never create or flicker a card before the final replacement.
		if (this.progressStyle === "none") return;

		if (options?.countTool) this.toolCallCount++;
		const changed = this.progress.record({ marker, text, tail: options?.tail === true });
		if (!changed && !options?.countTool) return;
		this.mode = "progress";
		this.bumpRevision(false);
	}

	private async sendFinal(text: string, shouldLog: boolean, title?: string): Promise<boolean> {
		if (this.closed || this.ending || !this.isCurrent || !text.trim()) return this.finalResponseDelivered;

		this.ending = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;

		if (this.progressStyle !== "none" && !this.hasRecordedProgress()) {
			// The card only ever said "正在处理…": the answer goes into it rather than into a second
			// message under a card that would just read "已答复。".
			this.finalReplacementText = text;
			this.mode = "finalize-with-fallback";
			this.bumpRevision(true);
			await this.flush();
		} else {
			if (!(await this.bot.sendPlain(this.event.channelId, text, title ? { title, markdown: true } : undefined))) {
				return false;
			}
			this.finalResponseDelivered = true;
			this.mode = "finalize-existing";
			this.bumpRevision(true);
		}
		// Do not archive a response we failed to deliver: the conversation log
		// must not claim we answered when the user never received it.
		if (!this.finalResponseDelivered) return false;

		if (shouldLog) {
			this.archiveBotResponse(text);
		}
		return true;
	}

	private async replaceWithFinal(text: string): Promise<void> {
		if (this.closed || this.finalResponseDelivered || !this.isCurrent || !text.trim()) return;

		this.ending = true;
		this.finalReplacementText = text;
		this.mode = "finalize-with-fallback";
		this.bumpRevision(true);
		await this.flush();
		if (!this.finalResponseDelivered && this.isCurrent) {
			throw new Error("最终答复发送失败，请稍后重试。");
		}
	}

	private async silence(): Promise<void> {
		if (this.closed || this.finalResponseDelivered) return;

		this.ending = true;
		this.mode = "silent";
		this.bumpRevision(true);
	}

	private bumpRevision(forceImmediate: boolean): void {
		this.desiredRevision++;
		this.schedule(forceImmediate);
	}

	private schedule(forceImmediate: boolean): void {
		if (this.running) return;
		if (forceImmediate || this.mode !== "progress") {
			if (this.timer) clearTimeout(this.timer);
			this.timer = null;
			void this.runSyncLoop();
			return;
		}
		if (this.timer) return;
		// One macrotask coalesces the first burst; subsequent frames respect the minimum gap.
		this.timer = setTimeout(
			() => {
				this.timer = null;
				void this.runSyncLoop();
			},
			Math.max(0, this.nextProgressAt - Date.now()),
		);
	}

	private async runSyncLoop(): Promise<void> {
		if (this.running) return;
		this.running = true;

		try {
			while (this.appliedRevision < this.desiredRevision) {
				const mode = this.mode;
				const revision = this.desiredRevision;
				const replacementText = this.finalReplacementText;
				let touchedRemote = false;

				try {
					if (mode === "progress") {
						if (this.isCurrent && this.progressFailures < MAX_PROGRESS_FAILURES) {
							touchedRemote = await this.publishProgress();
						}
					} else if (mode === "finalize-existing") {
						if (this.progressStyle !== "none") {
							touchedRemote = await this.bot.finalizeExistingCard(
								this.event.channelId,
								this.buildSummaryText(),
								this.cardGeneration,
							);
						}
					} else if (mode === "finalize-with-fallback") {
						if (replacementText.trim()) {
							touchedRemote = await this.bot.finalizeCard(
								this.event.channelId,
								replacementText,
								this.cardGeneration,
							);
							this.finalResponseDelivered = touchedRemote;
						}
					} else if (mode === "silent") {
						if (this.progressStyle !== "none") {
							touchedRemote = await this.bot.finalizeExistingCard(
								this.event.channelId,
								renderCardStatus(SILENT_STATUS),
								this.cardGeneration,
							);
						}
					}
				} catch (err) {
					log.logWarn("delivery.sync.failed", "Delivery sync failed", {
						channelId: this.event.channelId,
						reason: errorMessage(err),
					});
					if (mode === "progress") this.progressFailures++;
				}

				this.appliedRevision = revision;
				// Events received during HTTP must wait for the next display interval. An ending
				// still runs immediately after the in-flight write, without draining old progress.
				if (mode === "progress" && this.mode === "progress") break;
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
					log.logWarn("delivery.flush.timeout", "Delivery flush deadline exceeded; releasing caller", {
						channelId: this.event.channelId,
						fields: { deadlineMs: FLUSH_DEADLINE_MS },
					});
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
		if (this.mode === "progress") {
			this.mode = "silent";
			this.bumpRevision(true);
		}
		await this.flush();
		this.bot.discardCard(this.event.channelId, this.cardGeneration);
	}

	/** True once this turn has something to show besides the waiting line. */
	private hasRecordedProgress(): boolean {
		return this.progress.hasContent || this.document !== "";
	}

	/** Publish one bounded write per display interval, anchored to the last successful write. */
	private async publishProgress(): Promise<boolean> {
		if (this.ending || !this.isCurrent) return false;
		const hasProgress = this.progress.hasContent;
		const planned: ProgressWrite | undefined = hasProgress
			? this.progress.plan(
					this.buildLiveHeader(),
					{ epoch: this.documentEpoch, content: this.document },
					this.bot.supportsStreamingAppend(),
				)
			: { epoch: -1, content: WAITING_TEXT, append: false, document: "", complete: true };
		if (!planned) return false;
		try {
			const write = planned.append ? this.bot.appendToCard.bind(this.bot) : this.bot.replaceCard.bind(this.bot);
			const ok = await write(this.event.channelId, planned.content, false, false, this.cardGeneration);
			if (ok) {
				if (hasProgress) {
					// Apply this immutable request's baseline, even if newer events folded the desired
					// view during HTTP. Its epoch forces the next write to replace that old cycle.
					this.document = planned.document;
					this.documentEpoch = planned.epoch;
				}
				this.progressFailures = 0;
				if (!planned.complete && !this.ending) this.bumpRevision(false);
			} else {
				this.progressFailures++;
				if (planned.append) {
					// The server may have applied an append whose response was lost. Replacing a short
					// new cycle restores certainty without duplicating that delta or replaying history.
					this.progress.rebase();
					if (this.progressFailures < MAX_PROGRESS_FAILURES && !this.ending) this.bumpRevision(false);
				}
			}
			return ok;
		} finally {
			this.nextProgressAt = Date.now() + PROGRESS_INTERVAL_MS;
		}
	}

	/** Clock-style elapsed time (`0:42`, `1:02`, `1:05:09`) for the card's first line. */
	private formatClock(ms: number): string {
		const seconds = Math.max(0, Math.round(ms / 1000));
		const minutes = Math.floor(seconds / 60);
		const ss = String(seconds % 60).padStart(2, "0");
		if (minutes < 60) return `${minutes}:${ss}`;
		return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${ss}`;
	}

	private elapsedMs(): number {
		return Date.now() - this.progressStartedAt;
	}

	/**
	 * Cycle header, refreshed on replacement so it remains a stable prefix for appended progress.
	 * A long turn can retain only the latest thought and a few activity lines after a fold, so
	 * without this a long turn looks identical to one that just started. Counted as tool calls,
	 * never "steps" — a step is a task's unit (spec 053, D4).
	 */
	private buildLiveHeader(): string {
		return `⏱ ${this.formatClock(this.elapsedMs())} · 工具 ${this.toolCallCount}`;
	}

	private buildSummaryText(): string {
		return renderCardStatus(`完成 · 工具调用 ${this.toolCallCount} 次 · ${formatElapsedZh(this.elapsedMs())}`);
	}
}

/**
 * The output port for one turn. A `quiet` turn (a background wake) draws no progress; its answer is
 * delivered the same way, so a wake that has something to say still says it.
 */
export function createDingTalkContext(
	turn: TurnInfo,
	port: DeliveryPort,
	archive: ArchiveBotResponse,
	quiet: boolean,
): ChannelContext {
	const controller = new ChannelDeliveryController(turn, port, archive, quiet);
	return controller.buildContext();
}
