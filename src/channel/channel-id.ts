/**
 * The format of a channel id — the one place it is defined (spec 058, D11). A channel id is an
 * address only: a JSON key, a record field, a log field. It is never a path segment (INV-3).
 *
 * `dm_<staffId>` and `group_<conversationId>` come from DingTalk; a DingTalk conversation id is
 * base64 and routinely contains `/` and `=`, so the remainder is unconstrained apart from NUL.
 * The terminal UI is the single channel `tui`.
 */
export const TUI_CHANNEL_ID = "tui";

const DINGTALK_CHANNEL_ID_PATTERN = /^(dm|group)_[^\0]+$/;

export type ChannelKind = "dm" | "group" | "tui";

/** `dm_…` → `dm`, `group_…` → `group`, `tui` → `tui`; `undefined` for anything that is not a channel id. */
export function channelKind(channelId: string): ChannelKind | undefined {
	if (channelId === TUI_CHANNEL_ID) return "tui";
	const match = DINGTALK_CHANNEL_ID_PATTERN.exec(channelId);
	return match ? (match[1] as "dm" | "group") : undefined;
}

/** DingTalk's conversation type for a channel: `"2"` for a group, `"1"` otherwise. */
export function conversationTypeOf(channelId: string): "1" | "2" {
	return channelId.startsWith("group_") ? "2" : "1";
}

/**
 * How a channel is named to a user (spec 053 copy): `群「名称」`, `私聊「昵称」`, `终端`, or the
 * id itself when the channel index has no name for it. The one renderer behind `/dot`, `/tasks`
 * and `/events`.
 */
export function formatChannelLabel(channelId: string, name: string | undefined): string {
	const kind = channelKind(channelId);
	if (kind === "tui") return "终端";
	if (!name) return `\`${channelId}\``;
	return kind === "group" ? `群「${name}」` : `私聊「${name}」`;
}

/** What a report needs to say about a delivery channel: its label, and whether it is still bound to this dot. */
export interface ChannelDescription {
	label: string;
	boundHere: boolean;
}
