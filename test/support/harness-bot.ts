import { DingTalkBot } from "../../src/dingtalk/bot.js";
import type { DingTalkConfig } from "../../src/dingtalk/config.js";
import type { DingTalkIngress } from "../../src/dingtalk/inbound.js";

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

/**
 * A real `DingTalkBot` — inbound parsing, cards, the plain-send path — with every outbound call
 * captured instead of hitting the DingTalk API and no socket ever opened. Routing, queueing and
 * busy handling are the runtime's real `Ingress`, behind the real `DingTalkTransport`.
 *
 * This is what makes the deterministic e2e layer (spec 048) able to exercise
 * concurrency and interruption end to end without a live transport.
 */
export class HarnessDingTalkBot extends DingTalkBot {
	private readonly deliveryWaiters = new Set<{
		predicate: (delivery: CapturedDelivery) => boolean;
		resolve: (delivery: CapturedDelivery) => void;
	}>();
	constructor(
		ingress: DingTalkIngress,
		config: DingTalkConfig,
		readonly deliveries: CapturedDelivery[],
	) {
		super(ingress, config);
	}

	private capture(method: CapturedDelivery["method"], channelId: string, text?: string): void {
		const delivery = { method, channelId, text, ts: Date.now() };
		this.deliveries.push(delivery);
		for (const waiter of this.deliveryWaiters) {
			if (!waiter.predicate(delivery)) continue;
			this.deliveryWaiters.delete(waiter);
			waiter.resolve(delivery);
		}
	}

	whenDelivered(predicate: (delivery: CapturedDelivery) => boolean): Promise<CapturedDelivery> {
		const existing = this.deliveries.find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve: (delivery: CapturedDelivery) => {
					clearTimeout(timer);
					resolve(delivery);
				},
			};
			const timer = setTimeout(() => {
				this.deliveryWaiters.delete(waiter);
				reject(new Error("Timed out waiting for captured delivery"));
			}, 30_000);
			timer.unref();
			this.deliveryWaiters.add(waiter);
		});
	}

	/** No socket in the deterministic harness. */
	override async start(): Promise<void> {}

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

	override async finalizeExistingCard(channelId: string, content: string): Promise<boolean> {
		this.capture("finalizeExistingCard", channelId, content);
		return true;
	}

	override discardCard(channelId: string, generation?: symbol): void {
		this.capture("discardCard", channelId);
		super.discardCard(channelId, generation);
	}
}
