/**
 * Terminal implementation of the turn output port (`ChannelContext`).
 *
 * The DingTalk delivery (`dingtalk/delivery.ts`) drives AI Card streaming; the terminal has none of
 * that protocol, so this is a thin mapping from a turn's events onto a `TranscriptRenderer`.
 * Archiving mirrors `delivery.ts` so a channel produces the same conversation log regardless of
 * which surface it is driven from: a plainly delivered answer is archived; a replaced or silenced
 * one only re-renders.
 */
import type { ChannelContext, TurnEvent, TurnOutcome } from "../channel/channel-context.js";
import type { ChannelStore } from "../channel/store.js";
import type { TurnInfo } from "../channel/transport.js";
import type { TuiResponseMode } from "../config/settings.js";
import { describeToolCall } from "../tools/contract/presentation.js";
import type { TranscriptRenderer } from "./frontend.js";
import { formatProgressEntry } from "./progress.js";

export interface DeliveryTraits {
	progressStyle: "full" | "rolling" | "none";
	finalDelivery: "plain" | "card";
}

/** What `settings.json`'s `tui.responseMode` means for the terminal. */
export function traitsOf(mode: TuiResponseMode): DeliveryTraits {
	return {
		progressStyle:
			mode === "final_card_only" ? "none" : mode === "rolling_progress_then_plain_final" ? "rolling" : "full",
		finalDelivery: mode === "final_card_only" ? "card" : "plain",
	};
}

class TerminalDeliveryController {
	private closed = false;
	private finalDelivered = false;
	private lastAnswer = "";

	constructor(
		private readonly turn: TurnInfo,
		private readonly renderer: TranscriptRenderer,
		private readonly store: ChannelStore,
		private readonly traits: DeliveryTraits,
	) {}

	buildContext(): ChannelContext {
		return {
			emit: (event) => this.deliver(event),
			finish: async (outcome) => this.conclude(outcome),
		};
	}

	private deliver(event: TurnEvent): void {
		switch (event.type) {
			case "tool.start":
				this.appendProgress(formatProgressEntry("tool", describeToolCall(event.tool, event.args)));
				return;
			case "tool.update":
				this.appendProgress(formatProgressEntry("tool", event.text));
				return;
			case "tool.end":
				if (event.failure) this.appendProgress(formatProgressEntry("error", event.failure));
				return;
			case "reasoning":
				this.appendProgress(formatProgressEntry("thinking", event.text));
				return;
			case "commentary":
				this.deliverCommentary(event.text, event.level);
				return;
			case "answer":
				this.lastAnswer = event.text;
				if (this.traits.finalDelivery === "card") this.replaceWithFinal(event.text);
				else this.sendFinal(event.text);
				return;
			case "compaction":
				if (event.phase === "start") this.appendProgress(formatProgressEntry("assistant", "正在压缩上下文…"));
				return;
			case "steer.applied":
				return;
		}
	}

	private deliverCommentary(text: string, level: "error" | "warning" | "notice" | undefined): void {
		switch (level) {
			case undefined:
				this.appendProgress(formatProgressEntry("assistant", text));
				return;
			case "error":
				this.appendProgress(formatProgressEntry("error", text));
				return;
			case "warning":
				if (this.traits.progressStyle !== "none") this.appendProgress(formatProgressEntry("error", text));
				else this.notice(`⚠️ ${text}`);
				return;
			case "notice":
				this.notice(text);
				return;
		}
	}

	private conclude(outcome: TurnOutcome): void {
		if (this.closed) return;
		switch (outcome.kind) {
			case "failed":
				this.replaceWithFinal(outcome.message ?? "");
				break;
			case "silent":
			case "cancelled":
				this.silence();
				break;
			case "completed":
				if (this.lastAnswer && !this.finalDelivered) this.replaceWithFinal(this.lastAnswer);
				break;
		}
		this.closed = true;
	}

	private appendProgress(text: string): void {
		if (this.closed || this.finalDelivered || !text.trim()) return;
		// final_card_only shows no progress; drop stray progress writes.
		if (this.traits.progressStyle === "none") return;
		this.renderer.appendProgress(text);
	}

	private notice(text: string): void {
		if (!this.closed && text.trim()) this.renderer.showNotice(text);
	}

	private sendFinal(text: string): void {
		if (this.closed || this.finalDelivered || !text.trim()) return;
		this.renderer.showFinal(text);
		this.archive(text);
		this.finalDelivered = true;
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
		void this.store.logBotResponse(this.turn.channelId, text, Date.now().toString()).catch(() => {
			// Best-effort: a failed archive must never break rendering. delivery.ts
			// logs a warning here; the TUI keeps quiet to avoid corrupting the view.
		});
	}
}

export function createTerminalContext(
	turn: TurnInfo,
	renderer: TranscriptRenderer,
	store: ChannelStore,
	traits: DeliveryTraits,
): ChannelContext {
	return new TerminalDeliveryController(turn, renderer, store, traits).buildContext();
}
