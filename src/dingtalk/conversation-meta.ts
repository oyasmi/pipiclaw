/**
 * Per-channel conversation metadata (conversation id, DM vs group, sender): cached in memory and
 * persisted under the channel's state directory, so a card or plain message can be routed after a
 * restart or after the in-memory cache was reclaimed.
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getChannelDir } from "../channel/channel-paths.js";
import * as log from "../log.js";
import { writeFileAtomicallySync } from "../shared/atomic-file.js";
import { errorMessage } from "../shared/text-utils.js";
import type { ConversationMeta } from "./api.js";
import type { DingTalkConfig } from "./config.js";

export class ConversationMetaStore {
	// Conversation metadata cache: channelId → metadata
	private convMeta = new Map<string, ConversationMeta>();

	constructor(
		private config: Pick<DingTalkConfig, "stateDir">,
		/** Marks the channel as recently used, so the idle-cache sweep leaves it alone. */
		private touchChannel: (channelId: string) => void,
	) {}

	get(channelId: string): ConversationMeta | null {
		this.touchChannel(channelId);
		const cached = this.convMeta.get(channelId);
		if (cached) return cached;

		const metaPath = this.getPath(channelId);
		if (!metaPath || !existsSync(metaPath)) {
			return null;
		}

		try {
			const parsed = JSON.parse(readFileSync(metaPath, "utf-8")) as Partial<ConversationMeta>;
			if (!parsed.conversationId || !parsed.conversationType || !parsed.senderId) {
				return null;
			}

			const meta: ConversationMeta = {
				conversationId: parsed.conversationId,
				conversationType: parsed.conversationType,
				senderId: parsed.senderId,
			};
			this.convMeta.set(channelId, meta);
			return meta;
		} catch (err) {
			log.logWarn("dingtalk.metadata.load_failed", "Conversation metadata load failed", {
				channelId: channelId,
				reason: errorMessage(err),
			});
			return null;
		}
	}

	set(channelId: string, meta: ConversationMeta): void {
		this.touchChannel(channelId);
		this.convMeta.set(channelId, meta);

		const metaPath = this.getPath(channelId);
		if (!metaPath) return;

		try {
			mkdirSync(dirname(metaPath), { recursive: true });
			writeFileAtomicallySync(metaPath, JSON.stringify(meta, null, 2));
		} catch (err) {
			log.logWarn("dingtalk.metadata.persist_failed", "Conversation metadata persist failed", {
				channelId: channelId,
				reason: errorMessage(err),
			});
		}
	}

	/** Drop the in-memory entry only; the persisted file stays and is reloaded on demand. */
	evict(channelId: string): void {
		this.convMeta.delete(channelId);
	}

	private getPath(channelId: string): string | null {
		if (!this.config.stateDir) return null;
		return join(getChannelDir(this.config.stateDir, channelId), ".channel-meta.json");
	}
}
