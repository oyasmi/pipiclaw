/** One paced controller per immutable owner; a wake borrows it instead of opening a card. */
import type { DeliveryScopeRef, ScopeDeliveryPort, ScopeWriter } from "../channel/delivery-scope.js";
import { deliveryScopeKey } from "../channel/delivery-scope.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import type { DingTalkBot } from "./bot.js";
import { type ArchiveBotResponse, createDingTalkScopeWriter, type DeliveryPort } from "./delivery.js";

export class DingTalkScopeDelivery implements ScopeDeliveryPort {
	private readonly writers = new Map<
		string,
		{ owner: DeliveryScopeRef; writer: ScopeWriter; canWrite: () => boolean; revoke: () => void }
	>();
	constructor(
		private readonly bot: DingTalkBot,
		private readonly archive: ArchiveBotResponse,
	) {}
	invalidate(channelId: string): void {
		for (const [key, entry] of this.writers) {
			if (entry.owner.channelId !== channelId) continue;
			entry.revoke();
			this.bot.resetScopeCard(key);
		}
	}

	open(
		owner: DeliveryScopeRef,
		recovered: boolean,
		allowed: () => boolean = () => true,
		opts?: { deferCard?: boolean },
	): ScopeWriter {
		const key = `scope:${deliveryScopeKey(owner)}`;
		const existing = this.writers.get(key);
		if (existing?.canWrite()) return existing.writer;
		if (existing || recovered) {
			this.bot.resetScopeCard(key);
			recovered = true;
		}
		let revoked = false;
		const canWrite = () => {
			revoked ||= !allowed();
			return !revoked;
		};
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
			closeCard: (_channel, text, generation) => bot.closeCard(key, text, generation),
			discardCard: (_channel, generation) => bot.discardCard(key, generation),
		};
		const inner = createDingTalkScopeWriter(
			{ channelId: owner.channelId, user: "", text: "", ts: "" },
			port,
			this.archive,
			recovered,
			opts?.deferCard === true,
		);
		const writer: ScopeWriter = {
			...inner,
			report: async (report) => {
				if (!canWrite()) return { status: "blocked" };
				// Reports are durable documents, not lossy progress frames. The task outbox
				// alone owns FIFO/retry; a final summary can never replace this independent send.
				const ok = await bot.sendPlain(owner.channelId, report.text, {
					markdown: true,
					scopeRef: owner,
					canWrite,
				});
				if (ok) {
					await this.archive(owner.channelId, report.text).catch((error) =>
						log.logWarn("channel.archive.write_failed", "Bot response archive failed", {
							channelId: owner.channelId,
							reason: errorMessage(error),
						}),
					);
				}
				return { status: ok ? "confirmed" : !canWrite() ? "blocked" : "unknown" };
			},
		};
		this.writers.set(key, {
			owner,
			writer,
			canWrite,
			revoke: () => {
				revoked = true;
			},
		});
		return writer;
	}
	async stop(): Promise<void> {
		await Promise.all([...this.writers.values()].map(({ writer }) => writer.close()));
	}
}
