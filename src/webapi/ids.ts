/**
 * Identifiers the Web API hands out (spec 061, D12/D16): a prefix naming the kind of thing, then
 * 128 random bits as hex. The conversation id doubles as the tail of a channel id and as a
 * directory name under `state/webapi/`, which is why its character set is fixed (INV-3).
 */
import { randomBytes } from "node:crypto";

type IdPrefix = "resp" | "conv" | "msg" | "mcp" | "rs" | "steer";

export function newId(prefix: IdPrefix): string {
	return `${prefix}_${randomBytes(16).toString("hex")}`;
}

const CONVERSATION_ID = /^conv_[0-9a-f]{32}$/;
const STREAM_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isConversationId = (value: unknown): value is string =>
	typeof value === "string" && CONVERSATION_ID.test(value);
export const isStreamId = (value: unknown): value is string => typeof value === "string" && STREAM_ID.test(value);

/** `webapi:conv_…` — the channel a conversation is. */
export const channelIdOf = (conversationId: string): string => `webapi:${conversationId}`;

/** The conversation a `webapi:` channel id names; `undefined` for anything else. */
export function conversationIdOf(channelId: string): string | undefined {
	const id = channelId.startsWith("webapi:") ? channelId.slice("webapi:".length) : undefined;
	return isConversationId(id) ? id : undefined;
}
