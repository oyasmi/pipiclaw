/**
 * Inbound messages: acknowledge and deduplicate raw Stream frames, parse a robot message into a
 * `ChannelEvent`, apply the sender allow-list, resolve image attachments, and hand the event to the
 * bot's routing. The per-channel ingestion queue lives here so an attachment download can never be
 * overtaken by a later message on the same channel.
 */
import type { DWClientDownStream } from "dingtalk-stream";
import type { InboundImage } from "../channel/channel-event.js";
import * as log from "../log.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { DingTalkConfig } from "./config.js";
import type { ConversationMetaStore } from "./conversation-meta.js";
import type { DingTalkEvent, DingTalkHandler } from "./handler.js";
import { type ParsedInboundMessage, parseInboundMessage } from "./inbound-media.js";

interface DingTalkIncomingMessage {
	msgId?: string;
	senderStaffId?: string;
	senderId?: string;
	senderNick?: string;
	conversationId?: string;
	conversationType?: string;
	/** Group title. Present on group messages only; DingTalk omits it for DMs. */
	conversationTitle?: string;
	msgtype?: string;
	text?: {
		content?: string;
	};
	content?: {
		richText?: Array<Record<string, string>>;
		/** Present on a `picture` message; see `inbound-media.ts`'s `parseInboundMessage`. */
		downloadCode?: string;
	};
}

export interface InboundMessagesDeps {
	config: DingTalkConfig;
	handler: DingTalkHandler;
	conversations: ConversationMetaStore;
	isStopped: () => boolean;
	/** Acknowledge a downstream frame to DingTalk. */
	ack: (messageId: string) => void;
	resolveInboundAttachments: (
		channelId: string,
		parsed: ParsedInboundMessage,
	) => Promise<{ text: string; images: InboundImage[] }>;
	/** Command / busy / `/new` routing for a built event (the bot's `routeInboundEvent`). */
	routeInboundEvent: (event: DingTalkEvent) => Promise<void>;
}

export class InboundMessages {
	// Deduplication cache (Set for O(1) lookup, order array for FIFO eviction)
	private processedIds = new Set<string>();
	private processedIdsOrder: string[] = [];
	// Serializes "resolve inbound image attachments → build event → route" per channel (spec 049
	// D3): a message needing a download must not be overtaken, in delivery order, by a later
	// download-free message on the same channel. `pendingInboundIngestCount` lets the bot's
	// `allChannelQueuesIdle()` see this in-flight network work, which `ChannelQueue.isIdle()`
	// alone cannot — the event has not been built yet, let alone enqueued.
	private inboundIngestQueue = createSerialQueue<string>();
	private pendingInboundIngestCount = 0;

	constructor(private deps: InboundMessagesDeps) {}

	/** True while an inbound message is still being ingested (downloading, not yet enqueued). */
	hasPendingIngest(): boolean {
		return this.pendingInboundIngestCount > 0;
	}

	/**
	 * Mark an ID as processed. Returns true if this is a new ID, false if already seen.
	 * Maintains a FIFO buffer of at most 200 entries.
	 */
	private markProcessed(id: string): boolean {
		if (this.processedIds.has(id)) return false;
		this.processedIds.add(id);
		this.processedIdsOrder.push(id);
		while (this.processedIdsOrder.length > 200) {
			this.processedIds.delete(this.processedIdsOrder.shift()!);
		}
		return true;
	}

	handleRawMessage(msg: DWClientDownStream): { status: "SUCCESS"; message: string } {
		// 1. Immediate ACK
		if (msg.headers?.messageId) {
			this.deps.ack(msg.headers.messageId);
		}

		// 2. Protocol deduplication
		const messageId = msg.headers?.messageId;
		if (messageId && !this.markProcessed(messageId)) {
			return { status: "SUCCESS", message: "OK" };
		}

		try {
			const parsedData = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
			const data: DingTalkIncomingMessage = isRecord(parsedData) ? parsedData : {};

			// 3. Business logic deduplication
			const msgId = data.msgId;
			if (msgId && !this.markProcessed(msgId)) {
				return { status: "SUCCESS", message: "OK" };
			}

			// Fire-and-forget processing
			this.onStreamMessage(data).catch((err: unknown) => {
				log.logWarn("dingtalk.handler.failed", "Message handler failed", { reason: errorMessage(err) });
			});
		} catch (err) {
			log.logWarn("dingtalk.message.parse_failed", "Message parse failed", { reason: errorMessage(err) });
		}

		return { status: "SUCCESS", message: "OK" };
	}

	async onStreamMessage(data: DingTalkIncomingMessage): Promise<void> {
		const { config, handler } = this.deps;
		if (this.deps.isStopped()) {
			return;
		}

		const parsed = parseInboundMessage(data);
		const senderId = data.senderStaffId || data.senderId || "";
		const senderName = data.senderNick || "Unknown";
		const conversationId = data.conversationId || "";
		const conversationType = data.conversationType || "1";

		if (!parsed.text && parsed.downloadCodes.length === 0) {
			const msgtype = typeof data.msgtype === "string" ? data.msgtype : "unknown";
			log.logWarn("dingtalk.message.empty", "Empty message ignored", { fields: { msgtype } });
			return;
		}

		if (config.allowFrom && config.allowFrom.length > 0) {
			if (!config.allowFrom.includes(senderId)) {
				log.logWarn("dingtalk.message.unauthorized", "Message from unauthorized user ignored", {
					fields: { senderName, senderId },
				});
				return;
			}
		}

		// Determine channel ID
		const channelId = conversationType === "2" ? `group_${conversationId}` : `dm_${senderId}`;

		// Parsing above is free; resolving image attachments below is a real network round-trip.
		// Serialize the whole "resolve attachments → build event → route" unit per channel (spec
		// 049 D3): without this, a message needing a download can be overtaken, in delivery order,
		// by a later download-free message on the same channel — nothing upstream of
		// `enqueueStreamMessage` otherwise waits on anything asynchronous.
		this.pendingInboundIngestCount++;
		try {
			await this.inboundIngestQueue.run(channelId, async () => {
				const { text: content, images } = await this.deps.resolveInboundAttachments(channelId, parsed);

				log.logEvent("info", "runtime.dingtalk.message_received", "Accepted incoming message", {
					ctx: { channelId, userName: senderName },
					fields: { messageType: conversationType === "2" ? "group" : "dm", messageLength: content.length },
				});

				// A group carries its title on every message; a DM has none, so the peer's nickname
				// is the only human-readable handle that channel will ever have.
				const conversationTitle = typeof data.conversationTitle === "string" ? data.conversationTitle.trim() : "";
				const channelName = (conversationType === "2" ? conversationTitle : senderName) || undefined;

				// Cache conversation metadata for card creation
				this.deps.conversations.set(channelId, {
					conversationId,
					conversationType,
					senderId,
				});

				// The one place a real person's message is seen before command/busy routing splits
				// the path, so the channel index counts every human message and no synthetic wake.
				handler.noteChannelActivity?.({ channelId, name: channelName, at: Date.now() });

				// Build event
				const event: DingTalkEvent = {
					type: conversationType === "2" ? "group" : "dm",
					channelId,
					ts: Date.now().toString(),
					user: senderId,
					userName: senderName,
					text: content,
					conversationId,
					conversationType,
					...(channelName ? { channelName } : {}),
					...(images.length > 0 ? { images } : {}),
				};

				await this.deps.routeInboundEvent(event);
			});
		} finally {
			this.pendingInboundIngestCount--;
		}
	}
}
