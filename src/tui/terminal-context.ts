/**
 * Terminal implementation of the `ChannelContext` delivery contract.
 *
 * The DingTalk delivery controller (`runtime/delivery.ts`) drives AI Card
 * streaming; the terminal has none of that protocol, so this controller is a
 * thin mapping from the contract onto a `TranscriptRenderer`. Archiving
 * semantics mirror `delivery.ts` so a channel produces the same conversation log
 * regardless of which surface it is driven from:
 *   - `respond` / `respondPlain` archive when `shouldLog` is set;
 *   - `replaceMessage` / `deleteMessage` do not archive (they only re-render).
 */
import type { ChannelContext, FinalDelivery, ProgressStyle } from "../runtime/channel-context.js";
import type { ChannelStore } from "../runtime/store.js";
import type { TranscriptRenderer } from "./renderer.js";

/** The minimal per-turn input the terminal context needs (no DingTalk types). */
export interface TurnInput {
	text: string;
	user: string;
	userName?: string;
	channel: string;
	ts: string;
}

export interface DeliveryTraits {
	progressStyle: ProgressStyle;
	finalDelivery: FinalDelivery;
}

class TerminalDeliveryController {
	private closed = false;
	private finalDelivered = false;

	constructor(
		private readonly input: TurnInput,
		private readonly renderer: TranscriptRenderer,
		private readonly store: ChannelStore,
		private readonly traits: DeliveryTraits,
	) {}

	buildContext(): ChannelContext {
		const { text, user, userName, channel, ts } = this.input;
		return {
			message: { text, rawText: text, user, userName, channel, ts },
			channelName: channel,
			respond: async (progress: string, shouldLog = true) => this.appendProgress(progress, shouldLog),
			respondPlain: async (final: string, shouldLog = true) => this.sendFinal(final, shouldLog),
			replaceMessage: async (final: string) => this.replaceWithFinal(final),
			respondInThread: async (notice: string) => {
				if (notice.trim()) {
					this.renderer.showNotice(notice);
				}
			},
			setTyping: async () => {},
			setWorking: async (working: boolean) => {
				this.renderer.setWorking(working);
			},
			deleteMessage: async () => this.silence(),
			primeCard: () => {},
			flush: async () => {},
			close: async () => {
				this.closed = true;
			},
			progressStyle: this.traits.progressStyle,
			finalDelivery: this.traits.finalDelivery,
		};
	}

	private appendProgress(text: string, shouldLog: boolean): void {
		if (this.closed || this.finalDelivered || !text.trim()) return;
		// final_card_only shows no progress; drop stray progress writes.
		if (this.traits.progressStyle === "none") return;
		this.renderer.appendProgress(text);
		if (shouldLog) {
			this.archive(text);
		}
	}

	private sendFinal(text: string, shouldLog: boolean): boolean {
		if (this.closed || this.finalDelivered) return this.finalDelivered;
		if (!text.trim()) return false;
		this.renderer.showFinal(text);
		if (shouldLog) {
			this.archive(text);
		}
		this.finalDelivered = true;
		return true;
	}

	private replaceWithFinal(text: string): void {
		if (this.closed || this.finalDelivered) return;
		this.renderer.clearProgress();
		if (text.trim()) {
			this.renderer.showFinal(text);
		}
		this.finalDelivered = true;
	}

	private silence(): void {
		if (this.closed || this.finalDelivered) return;
		this.renderer.clearProgress();
		this.finalDelivered = true;
	}

	private archive(text: string): void {
		void this.store.logBotResponse(this.input.channel, text, Date.now().toString()).catch(() => {
			// Best-effort: a failed archive must never break rendering. delivery.ts
			// logs a warning here; the TUI keeps quiet to avoid corrupting the view.
		});
	}
}

export function createTerminalContext(
	input: TurnInput,
	renderer: TranscriptRenderer,
	store: ChannelStore,
	traits: DeliveryTraits,
): ChannelContext {
	return new TerminalDeliveryController(input, renderer, store, traits).buildContext();
}
