/**
 * Draws a Response's event stream on the terminal (spec 061, D25). The stream is the Web API's
 * Responses events; this turns them into the transcript calls a `Frontend` offers — a progress
 * line per tool call, the model's reasoning and commentary, then the final answer — the way the
 * terminal always has, with `settings.json`'s `tui.responseMode` deciding how much is shown.
 */
import type { TuiResponseMode } from "../config/settings.js";
import { describeToolCall } from "../tools/contract/presentation.js";
import type { TranscriptRenderer } from "./frontend.js";

export interface DeliveryTraits {
	progressStyle: "full" | "rolling" | "none";
	finalDelivery: "plain" | "card";
}

export function traitsOf(mode: TuiResponseMode): DeliveryTraits {
	return {
		progressStyle:
			mode === "final_card_only" ? "none" : mode === "rolling_progress_then_plain_final" ? "rolling" : "full",
		finalDelivery: mode === "final_card_only" ? "card" : "plain",
	};
}

/** The parts of a Response event the terminal reads (the SDK's union is much wider). */
export interface StreamEvent {
	type: string;
	item?: {
		id?: string;
		type?: string;
		name?: string;
		arguments?: string;
		status?: string;
		phase?: string;
		summary?: Array<{ text?: string }>;
		content?: Array<{ type?: string; text?: string }>;
		error?: { content?: string } | null;
		/** Pipiclaw's extensions: a tool failure worded for the user; the level of runtime commentary. */
		pipiclaw_failure?: string;
		pipiclaw_level?: "error" | "warning" | "notice";
	};
	response?: {
		status?: string;
		error?: { message?: string } | null;
		incomplete_details?: { reason?: string } | null;
	};
	error?: { message?: string };
	message?: string;
}

type ProgressKind = "tool" | "thinking" | "error" | "assistant";

/** One line, prefixed by what kind of entry it is; `""` when there is nothing to show. */
function progressLine(kind: ProgressKind, text: string): string {
	const normalized = text.replace(/￼/g, "").replace(/\r/g, "").replace(/\n+/g, " ").trim();
	if (!normalized) return "";
	switch (kind) {
		case "tool":
			return `➜ ${normalized}`;
		case "thinking":
			return `✦ ${normalized}`;
		case "error":
			return `✕ ${normalized}`;
		case "assistant":
			return normalized;
	}
}

function parseArguments(text: string | undefined): unknown {
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		return {};
	}
}

const textOf = (content: Array<{ text?: string }> | undefined): string =>
	(content ?? []).map((part) => part.text ?? "").join("");

export class EventRenderer {
	private lastAnswer = "";
	private answered = false;

	constructor(
		private readonly out: TranscriptRenderer,
		private readonly traits: DeliveryTraits,
	) {}

	handle(event: StreamEvent): void {
		switch (event.type) {
			case "response.created":
				this.lastAnswer = "";
				this.answered = false;
				return;
			case "response.output_item.added":
				if (event.item?.type === "mcp_call") {
					this.progress("tool", describeToolCall(event.item.name ?? "", parseArguments(event.item.arguments)));
				}
				return;
			case "response.output_item.done":
				this.itemDone(event.item);
				return;
			case "response.completed":
				// Card mode shows the answer only now, in place of any progress.
				if (this.traits.finalDelivery === "card" && this.lastAnswer && !this.answered) {
					this.out.clearProgress();
					this.out.showFinal(this.lastAnswer);
					this.answered = true;
				}
				return;
			case "response.failed":
				this.out.clearProgress();
				this.out.showFinal(event.response?.error?.message ?? "处理失败。");
				return;
			case "error":
				this.out.showNotice(`✕ ${event.error?.message ?? event.message ?? "请求失败。"}`);
				return;
		}
	}

	private itemDone(item: StreamEvent["item"]): void {
		if (!item) return;
		if (item.type === "mcp_call") {
			// A failed call the model is expected to correct stays out of sight; only a failure worded
			// for the user (a guard refusal) is shown, as on every other channel.
			if (item.status === "failed" && item.pipiclaw_failure) this.progress("error", item.pipiclaw_failure);
		} else if (item.type === "reasoning") {
			this.progress("thinking", textOf(item.summary));
		} else if (item.type === "message") {
			const text = textOf(item.content);
			if (item.phase === "commentary") {
				this.commentary(text, item.pipiclaw_level);
			} else if (text.trim()) {
				this.lastAnswer = text;
				if (this.traits.finalDelivery === "plain") {
					this.out.showFinal(text);
					this.answered = true;
				}
			}
		}
	}

	private commentary(text: string, level: "error" | "warning" | "notice" | undefined): void {
		switch (level) {
			case undefined:
				this.progress("assistant", text);
				return;
			case "error":
				this.progress("error", text);
				return;
			case "warning":
				if (this.traits.progressStyle !== "none") this.progress("error", text);
				else this.out.showNotice(`⚠️ ${text}`);
				return;
			case "notice":
				this.out.showNotice(text);
				return;
		}
	}

	private progress(kind: ProgressKind, text: string): void {
		if (this.traits.progressStyle === "none" || this.answered) return;
		const line = progressLine(kind, text);
		if (line) this.out.appendProgress(line);
	}
}
