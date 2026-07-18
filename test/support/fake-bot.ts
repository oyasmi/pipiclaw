import type { FinalDelivery, ProgressStyle } from "../../src/runtime/channel-context.js";
import { finalDeliveryOf, progressStyleOf, type ResponseMode } from "../../src/runtime/dingtalk.js";

export interface CapturedDelivery {
	method:
		| "ensureCard"
		| "appendToCard"
		| "replaceCard"
		| "streamToCard"
		| "finalizeExistingCard"
		| "finalizeCard"
		| "discardCard"
		| "sendPlain";
	channelId: string;
	text?: string;
	ts: number;
}

export class E2EFakeDingTalkBot {
	deliveries: CapturedDelivery[] = [];
	responseMode: ResponseMode = "full_progress_then_plain_final";

	get progressStyle(): ProgressStyle {
		return progressStyleOf(this.responseMode);
	}

	get finalDelivery(): FinalDelivery {
		return finalDeliveryOf(this.responseMode);
	}

	async start(): Promise<void> {}

	async stop(): Promise<void> {}

	private capture(method: CapturedDelivery["method"], channelId: string, text?: string): void {
		this.deliveries.push({ method, channelId, text, ts: Date.now() });
	}

	async streamToCard(channelId: string, text: string): Promise<boolean> {
		this.capture("streamToCard", channelId, text);
		return true;
	}

	async appendToCard(channelId: string, text: string): Promise<boolean> {
		this.capture("appendToCard", channelId, text);
		return true;
	}

	async replaceCard(channelId: string, text: string, finalize: boolean = false): Promise<boolean> {
		this.capture("replaceCard", channelId, finalize ? `${text} [finalize]` : text);
		return true;
	}

	async ensureCard(channelId: string): Promise<void> {
		this.capture("ensureCard", channelId);
	}

	async finalizeExistingCard(channelId: string, text: string): Promise<boolean> {
		this.capture("finalizeExistingCard", channelId, text);
		return true;
	}

	async finalizeCard(channelId: string, text: string): Promise<boolean> {
		this.capture("finalizeCard", channelId, text);
		return true;
	}

	discardCard(channelId: string): void {
		this.capture("discardCard", channelId);
	}

	async sendPlain(channelId: string, text: string): Promise<boolean> {
		this.capture("sendPlain", channelId, text);
		return true;
	}
}
