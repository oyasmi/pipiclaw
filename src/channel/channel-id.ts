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

export function isChannelId(value: string): boolean {
	return value === TUI_CHANNEL_ID || DINGTALK_CHANNEL_ID_PATTERN.test(value);
}

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
