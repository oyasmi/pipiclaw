/**
 * DingTalk routing metadata per channel (conversation id, DM vs group, sender), so a card or plain
 * message can be routed after a restart. One file for every channel, `state/dingtalk/
 * conversations.json`, keyed by channel id (spec 058, D17): loaded once, kept in memory, and
 * rewritten only when an entry actually changes. Unbound channels are recorded too, so a later
 * binding can push to them.
 */
import { readFileSync } from "fs";
import { join } from "path";
import * as log from "../log.js";
import { writeFileAtomicallySync } from "../shared/atomic-file.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import type { ConversationMeta } from "./api.js";
import type { DingTalkConfig } from "./config.js";

function isNodeErrorCode(error: unknown, code: string): boolean {
	return isPlainObject(error) && (error as { code?: unknown }).code === code;
}

function parseMeta(value: unknown): ConversationMeta | undefined {
	if (!isPlainObject(value)) return undefined;
	const { conversationId, conversationType, senderId } = value;
	if (typeof conversationId !== "string" || typeof conversationType !== "string" || typeof senderId !== "string") {
		return undefined;
	}
	if (!conversationId || !conversationType || !senderId) return undefined;
	return { conversationId, conversationType, senderId };
}

function sameMeta(a: ConversationMeta | undefined, b: ConversationMeta): boolean {
	return (
		a !== undefined &&
		a.conversationId === b.conversationId &&
		a.conversationType === b.conversationType &&
		a.senderId === b.senderId
	);
}

export class ConversationMetaStore {
	private entries?: Map<string, ConversationMeta>;

	constructor(
		/** `stateDir` is the app's `state/` directory; omit it to keep metadata in memory only. */
		private config: Pick<DingTalkConfig, "stateDir">,
		/** Marks the channel as recently used, so the idle-cache sweep leaves it alone. */
		private touchChannel: (channelId: string) => void,
	) {}

	private get path(): string | undefined {
		return this.config.stateDir ? join(this.config.stateDir, "dingtalk", "conversations.json") : undefined;
	}

	private load(): Map<string, ConversationMeta> {
		if (this.entries) return this.entries;
		const entries = new Map<string, ConversationMeta>();
		const path = this.path;
		if (path) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
				for (const [channelId, value] of Object.entries(isPlainObject(parsed) ? parsed : {})) {
					const meta = parseMeta(value);
					if (meta) entries.set(channelId, meta);
				}
			} catch (err) {
				if (!isNodeErrorCode(err, "ENOENT")) {
					log.logWarn("dingtalk.metadata.load_failed", "Conversation metadata load failed", {
						reason: errorMessage(err),
					});
				}
			}
		}
		this.entries = entries;
		return entries;
	}

	get(channelId: string): ConversationMeta | null {
		this.touchChannel(channelId);
		return this.load().get(channelId) ?? null;
	}

	/** Called on every inbound message; writes only when the entry is new or changed. */
	set(channelId: string, meta: ConversationMeta): void {
		this.touchChannel(channelId);
		const entries = this.load();
		if (sameMeta(entries.get(channelId), meta)) return;
		entries.set(channelId, meta);

		const path = this.path;
		if (!path) return;
		try {
			writeFileAtomicallySync(path, `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`);
		} catch (err) {
			log.logWarn("dingtalk.metadata.persist_failed", "Conversation metadata persist failed", {
				channelId: channelId,
				reason: errorMessage(err),
			});
		}
	}
}
