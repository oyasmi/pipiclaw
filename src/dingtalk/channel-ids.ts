/**
 * DingTalk's side of the channel-id format (spec 061, D10): `dingtalk:dm:<staffId>` for a private
 * chat and `dingtalk:group:<conversationId>` for a group. Only this transport interprets the part
 * after `dingtalk:`; the runtime sees an opaque address.
 */
import { parseChannelId } from "../channel/channel-id.js";

export type DingTalkChannelKind = "dm" | "group";

export function dingtalkDmChannelId(staffId: string): string {
	return `dingtalk:dm:${staffId}`;
}

export function dingtalkGroupChannelId(conversationId: string): string {
	return `dingtalk:group:${conversationId}`;
}

/** `undefined` for a channel id that is not a well-formed DingTalk address. */
export function parseDingTalkChannelId(channelId: string): { kind: DingTalkChannelKind; native: string } | undefined {
	const parsed = parseChannelId(channelId);
	if (parsed?.transport !== "dingtalk") return undefined;
	const colon = parsed.native.indexOf(":");
	if (colon <= 0) return undefined;
	const kind = parsed.native.slice(0, colon);
	const native = parsed.native.slice(colon + 1);
	if ((kind !== "dm" && kind !== "group") || !native) return undefined;
	return { kind, native };
}

/** DingTalk's conversation type for a channel: `"2"` for a group, `"1"` otherwise. */
export function conversationTypeFor(channelId: string): "1" | "2" {
	return parseDingTalkChannelId(channelId)?.kind === "group" ? "2" : "1";
}

/**
 * How a DingTalk channel is named to a user (spec 053 copy): `群「名称」`, `私聊「昵称」`, or the id
 * itself in backticks when the channel index has no name for it.
 */
export function describeDingTalkChannel(channelId: string, name: string | undefined): string {
	if (!name) return `\`${channelId}\``;
	return parseDingTalkChannelId(channelId)?.kind === "group" ? `群「${name}」` : `私聊「${name}」`;
}
