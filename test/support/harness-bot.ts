import type { DingTalkHandler } from "../../src/runtime/dingtalk.js";
import { DingTalkBot, type DingTalkConfig } from "../../src/runtime/dingtalk.js";
import type { CapturedDelivery } from "./fake-bot.js";

/**
 * A real `DingTalkBot` — real `ChannelQueue`, real `/steer` / `/followup` / `/stop`
 * / `/new` and busy routing (`routeInboundEvent`) — with every outbound call
 * captured instead of hitting the DingTalk API and no socket ever opened.
 *
 * This is what makes the deterministic e2e layer (spec 048) able to exercise
 * concurrency and interruption end to end without a live transport.
 */
export class HarnessDingTalkBot extends DingTalkBot {
	constructor(
		handler: DingTalkHandler,
		config: DingTalkConfig,
		readonly deliveries: CapturedDelivery[],
	) {
		super(handler, config);
	}

	private capture(method: CapturedDelivery["method"], channelId: string, text?: string): void {
		this.deliveries.push({ method, channelId, text, ts: Date.now() });
	}

	override async sendPlain(channelId: string, text: string): Promise<boolean> {
		this.capture("sendPlain", channelId, text);
		return true;
	}

	override async ensureCard(channelId: string): Promise<void> {
		this.capture("ensureCard", channelId);
	}

	override async replaceCard(channelId: string, content: string, finalize = false): Promise<boolean> {
		this.capture(finalize ? "finalizeExistingCard" : "replaceCard", channelId, content);
		return true;
	}

	override async appendToCard(channelId: string, content: string, finalize = false): Promise<boolean> {
		this.capture(finalize ? "finalizeExistingCard" : "appendToCard", channelId, content);
		return true;
	}

	override async finalizeCard(channelId: string, content: string): Promise<boolean> {
		this.capture("finalizeCard", channelId, content);
		return true;
	}

	override discardCard(channelId: string): void {
		this.capture("discardCard", channelId);
	}
}
