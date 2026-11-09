/** One paced controller per immutable owner; a wake borrows it instead of opening a card. */
import type { DeliveryScopeRef, ScopeDeliveryPort, ScopeWriter } from "../channel/delivery-scope.js";
import { deliveryScopeKey } from "../channel/delivery-scope.js";
import * as log from "../log.js";
import type { DingTalkBot } from "./bot.js";
import { type ArchiveBotResponse, createDingTalkScopeWriter, type DeliveryPort } from "./delivery.js";

export class DingTalkScopeDelivery implements ScopeDeliveryPort {
	private readonly writers = new Map<string, ScopeWriter>();
	constructor(
		private readonly bot: DingTalkBot,
		private readonly archive: ArchiveBotResponse,
		private readonly hasTemplate: boolean,
	) {}
	open(owner: DeliveryScopeRef, recovered: boolean, allowed: () => boolean = () => true): ScopeWriter {
		const key = `scope:${deliveryScopeKey(owner)}`;
		const existing = this.writers.get(key);
		if (existing) return existing;
		let revoked = false;
		const canWrite = () => {
			revoked ||= !allowed();
			return !revoked;
		};
		let fallback = false;
		this.bot.bindScopeCard(key, owner.channelId, canWrite);
		const bot = this.bot;
		const port: DeliveryPort = {
			canWrite,
			get progressStyle() {
				return bot.progressStyle;
			},
			get finalDelivery() {
				return recovered ? "plain" : bot.finalDelivery;
			},
			sendPlain: (_channel, text, opts) =>
				canWrite()
					? bot.sendPlain(owner.channelId, text, { ...opts, scopeRef: owner, canWrite })
					: Promise.resolve(false),
			getCardGeneration: () => bot.getCardGeneration(key),
			isCardGenerationCurrent: (_channel, generation) => bot.isCardGenerationCurrent(key, generation),
			replaceCard: (_channel, text, finalize, failed, generation) =>
				bot.replaceCard(key, text, finalize, failed, generation),
			appendToCard: (_channel, text, finalize, failed, generation) =>
				bot.appendToCard(key, text, finalize, failed, generation),
			supportsStreamingAppend: () => bot.supportsStreamingAppend(),
			finalizeCard: (_channel, text, generation) => bot.finalizeCard(key, text, generation),
			finalizeExistingCard: (_channel, text, generation) => bot.finalizeExistingCard(key, text, generation),
			discardCard: (_channel, generation) => bot.discardCard(key, generation),
		};
		const inner = createDingTalkScopeWriter(
			{ channelId: owner.channelId, user: "", text: "", ts: "" },
			port,
			this.archive,
			recovered,
		);
		const writer: ScopeWriter = {
			...inner,
			report: async (report) => {
				if (!canWrite()) return { status: "blocked" };
				// Explicit legacy path: no template/progress, or no recoverable old card reference.
				// Still require a real send acknowledgement; local retention never opens the close gate.
				if (fallback || recovered || !this.hasTemplate || bot.progressStyle === "none") {
					const ok = await bot.sendPlain(owner.channelId, report.text, {
						markdown: true,
						scopeRef: owner,
						canWrite,
					});
					return { status: ok ? "confirmed" : !canWrite() ? "blocked" : "unknown" };
				}
				inner.emit({ type: "commentary", text: report.text });
				const result = await inner.flush();
				if (result.status === "unknown" && bot.hasUnconfirmedCard(key)) {
					// CREATE may already exist remotely. Retain the failed report; its next durable
					// retry uses a real plain send instead of minting another card or opening the gate locally.
					fallback = true;
					log.logWarn("dingtalk.scope.degraded", "Scoped card delivery failed", {
						reason: "Unconfirmed CREATE; subsequent report retries use plain delivery",
						fields: { owner },
					});
				}
				return result;
			},
		};
		this.writers.set(key, writer);
		return writer;
	}
	async stop(): Promise<void> {
		await Promise.all([...this.writers.values()].map((writer) => writer.close()));
	}
}
