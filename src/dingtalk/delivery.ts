/**
 * The DingTalk implementation of the turn output port (`ChannelContext`): it reads a turn's
 * structured events and renders them as AI-Card progress, plain messages and a final answer,
 * including the "card failed, send it plainly" fallbacks. Progress appends whole list items
 * until the card nears the document ceiling, then one short snapshot replaces it. The answer
 * is a normal message and the card then folds to one line.
 */
import type { ChannelContext, TurnEvent, TurnOutcome } from "../channel/channel-context.js";
import type { TurnInfo } from "../channel/transport.js";
import * as log from "../log.js";
import { formatElapsedZh } from "../shared/format.js";
import { errorMessage } from "../shared/text-utils.js";
import { describeToolCall } from "../tools/contract/presentation.js";
import {
	CARD_COMPACT_MAX_BYTES,
	CARD_REQUEST_MAX_BYTES,
	type ProgressActivity,
	type ProgressWrite,
	planProgressWrite,
	renderCardStatus,
	renderProgressFrame,
	renderProgressLine,
} from "./progress.js";
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
	/** False once this process has learned that the template rejects an appended fragment. */
	supportsStreamingAppend(): boolean;
	finalizeCard(channelId: string, content: string, generation?: symbol): Promise<boolean>;
	finalizeExistingCard(channelId: string, content: string, generation?: symbol): Promise<boolean>;
	discardCard(channelId: string, generation?: symbol): void;
}

/** Records a delivered answer in the channel's conversation log. */
export type ArchiveBotResponse = (channelId: string, text: string) => Promise<void>;

const PROGRESS_WINDOW = 3;
const WAITING_TEXT = "正在处理…";
const MAX_PROGRESS_FAILURES = 2;
const SILENT_STATUS = "已处理，无需答复。";
// Last-resort ceiling on how long flush() will block a caller. Outbound HTTP now
// has its own timeout, so the sync loop is already bounded; this only guards against
// an unforeseen stall so run()'s finally can never hang the channel forever.
const FLUSH_DEADLINE_MS = 60_000;
/** How long a turn may stay silent before a "正在处理…" card appears. */
const CARD_WARMUP_MS = 3500;

type DeliveryMode = "progress" | "finalize-existing" | "finalize-with-fallback" | "silent";

class ChannelDeliveryController {
	private thinking = "";
	private activities: ProgressActivity[] = [];
	/** What the card shows after the warmup line has been replaced. Empty until the first real frame. */
	private document = "";
	/** Whole list items not yet on the card. */
	private pendingLines: string[] = [];
	private warmupDelivered = false;
	private mode: DeliveryMode = "progress";
	private desiredRevision = 0;
	private appliedRevision = 0;
	private running = false;
	private closed = false;
	private finalResponseDelivered = false;
	private ending = false;
	private progressFailures = 0;
	private readonly cardGeneration: symbol;
	private cardWarmupScheduled = false;
	private cardWarmupTriggered = false;
	private progressStartedAt = 0;
	private toolCallCount = 0;
	private timer: NodeJS.Timeout | null = null;
	private cardWarmupTimer: NodeJS.Timeout | null = null;
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
		this.cardGeneration = bot.getCardGeneration(turn.channelId);
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
				// Full mode keeps the latest thought pinned. Rolling lets it scroll with everything else.
				await this.remember(event.text, "✦", { pin: this.progressStyle === "full", tail: true });
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

	primeCard(delayMs: number): void {
		if (
			this.closed ||
			this.ending ||
			this.progressStyle === "none" ||
			this.cardWarmupScheduled ||
			this.cardWarmupTriggered
		) {
			return;
		}

		this.cardWarmupScheduled = true;
		this.cardWarmupTimer = setTimeout(
			() => {
				this.cardWarmupScheduled = false;
				this.cardWarmupTimer = null;
				if (this.closed || this.ending || !this.isCurrent || this.desiredRevision > 0) return;
				this.cardWarmupTriggered = true;
				// Use the same serialized loop as progress and completion; no detached create request.
				this.bumpRevision(true);
			},
			Math.max(0, delayMs),
		);
	}

	private clearCardWarmup(): void {
		this.cardWarmupScheduled = false;
		if (this.cardWarmupTimer) {
			clearTimeout(this.cardWarmupTimer);
			this.cardWarmupTimer = null;
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
	 * Record one progress line. `pin` holds the latest thinking for the next snapshot. The line
	 * itself is queued and appended; the header is rewritten only when the card is compressed.
	 */
	private async remember(
		text: string,
		marker: ProgressActivity["marker"],
		options?: { countTool?: boolean; pin?: boolean; tail?: boolean },
	): Promise<void> {
		if (this.closed || this.ending || !this.isCurrent || !text.trim()) return;
		// Final-card-only mode shows no progress; ignore any stray progress writes
		// so we never create or flicker a card before the final replacement.
		if (this.progressStyle === "none") return;

		this.clearCardWarmup();
		if (this.progressStartedAt === 0) this.progressStartedAt = Date.now();
		if (options?.countTool) this.toolCallCount++;
		if (options?.pin) {
			this.thinking = text;
		} else {
			this.activities.push({ marker, text, tail: options?.tail === true });
			while (this.activities.length > PROGRESS_WINDOW) this.activities.shift();
		}
		this.queueLine(marker, text, options?.tail === true);
		this.mode = "progress";
		this.bumpRevision(false);
	}

	/** Queue one finished list item. An unchanged tail is not sent again. */
	private queueLine(marker: ProgressActivity["marker"], text: string, tail: boolean): void {
		const line = renderProgressLine({ marker, text, tail });
		if (!line) return;
		const last = this.pendingLines.at(-1) ?? (this.document ? this.document.split("\n").at(-1) : undefined);
		if (line === last) return;
		this.pendingLines.push(line);
	}

	private async sendFinal(text: string, shouldLog: boolean, title?: string): Promise<boolean> {
		if (this.closed || this.ending || !this.isCurrent || !text.trim()) return this.finalResponseDelivered;

		this.ending = true;
		this.clearCardWarmup();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;

		if (this.cardWarmupTriggered && !this.hasRecordedProgress()) {
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
		this.clearCardWarmup();
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
		this.clearCardWarmup();
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

		// Endings go out immediately. Progress waits one macrotask so events already queued on the
		// delivery chain collapse into one write. Nothing polls on a clock.
		if (forceImmediate || this.mode !== "progress") {
			void this.runSyncLoop();
			return;
		}

		this.timer = setTimeout(() => {
			this.timer = null;
			void this.runSyncLoop();
		}, 0);
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
						if (this.document || this.cardWarmupTriggered || this.hasRecordedProgress()) {
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
						if (this.document || this.cardWarmupTriggered || this.hasRecordedProgress()) {
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
		this.clearCardWarmup();
		if (this.mode === "progress") {
			this.mode = "silent";
			this.bumpRevision(true);
		}
		await this.flush();
		this.bot.discardCard(this.event.channelId, this.cardGeneration);
	}

	/** True once this turn has something to show besides the warmup line. */
	private hasRecordedProgress(): boolean {
		return this.thinking !== "" || this.activities.length > 0 || this.document !== "";
	}

	/** Send queued progress, or the one-shot warmup line when nothing has been recorded yet. */
	private async publishProgress(): Promise<boolean> {
		if (this.pendingLines.length === 0) return this.publishWarmup();
		let touched = false;
		while (this.pendingLines.length > 0 && this.progressFailures < MAX_PROGRESS_FAILURES) {
			const step = await this.sendPending();
			if (step.touched) touched = true;
			if (!step.cont) break;
		}
		return touched;
	}

	private async publishWarmup(): Promise<boolean> {
		if (this.document || !this.cardWarmupTriggered || this.warmupDelivered) return false;
		const ok = await this.bot.replaceCard(this.event.channelId, WAITING_TEXT, false, false, this.cardGeneration);
		if (!ok) {
			this.progressFailures++;
			return false;
		}
		this.warmupDelivered = true;
		return true;
	}

	private async sendPending(): Promise<{ touched: boolean; cont: boolean }> {
		const planned = planProgressWrite({
			document: this.document,
			pending: this.pendingLines,
			append: this.bot.supportsStreamingAppend(),
			header: this.buildLiveHeader(),
			fallback: this.snapshot(CARD_REQUEST_MAX_BYTES, this.activities),
			compact: this.snapshot(CARD_COMPACT_MAX_BYTES, this.activities.slice(-1)),
		});
		if (!planned || planned.method === "drop") {
			if (planned?.method === "drop") this.pendingLines.shift();
			else this.pendingLines = [];
			return { touched: false, cont: planned?.method === "drop" };
		}
		const ok = await this.writeProgress(planned);
		if (ok) {
			this.applySent(planned);
			this.progressFailures = 0;
			return { touched: true, cont: true };
		}
		if (planned.method === "append") {
			const frame = this.bot.supportsStreamingAppend()
				? this.snapshot(CARD_COMPACT_MAX_BYTES, this.activities.slice(-1))
				: this.snapshot(CARD_REQUEST_MAX_BYTES, this.activities);
			const replaced = await this.bot.replaceCard(this.event.channelId, frame, false, false, this.cardGeneration);
			if (replaced) {
				this.document = frame;
				this.pendingLines = this.bot.supportsStreamingAppend()
					? this.pendingLines.filter((line) => !frame.split("\n").includes(line))
					: [];
				this.progressFailures = 0;
				return { touched: true, cont: false };
			}
		}
		this.progressFailures++;
		return { touched: false, cont: false };
	}

	private async writeProgress(planned: ProgressWrite): Promise<boolean> {
		if (planned.method === "append") {
			return this.bot.appendToCard(this.event.channelId, planned.content, false, false, this.cardGeneration);
		}
		return this.bot.replaceCard(this.event.channelId, planned.content, false, false, this.cardGeneration);
	}

	private applySent(planned: ProgressWrite): void {
		if (planned.method === "append") {
			this.document += planned.content;
			this.pendingLines.shift();
			return;
		}
		this.document = planned.content;
		if (planned.clearPending) {
			this.pendingLines = [];
			return;
		}
		const lines = new Set(planned.content.split("\n"));
		this.pendingLines = this.pendingLines.filter((line) => !lines.has(line));
	}

	/** A full snapshot: the live header, pinned thinking in full mode, and the given activities. */
	private snapshot(maxBytes: number, activities: ProgressActivity[]): string {
		return renderProgressFrame({
			header: this.buildLiveHeader(),
			thinking: this.progressStyle === "full" ? this.thinking : undefined,
			activities,
			maxBytes,
		});
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
		return this.progressStartedAt > 0 ? Date.now() - this.progressStartedAt : 0;
	}

	/**
	 * Standing first line. The card only keeps the latest thought and a few activity lines, so
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
	const context = controller.buildContext();
	// Same warm-up as before: a card that says "正在处理…" appears if the first output is slow.
	if (!quiet) controller.primeCard(CARD_WARMUP_MS);
	return context;
}
