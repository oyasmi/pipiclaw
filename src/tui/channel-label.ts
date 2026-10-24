/**
 * The terminal's own channel and how it names channels in `/desk` (spec 061, A1). Temporary: the
 * terminal becomes a Web API client in C1 and the daemon names channels itself, at which point
 * this file and the `tui` channel go away (C3).
 */
import { parseChannelId } from "../channel/channel-id.js";

export const TUI_CHANNEL_ID = "tui";

/** `群「名称」`, `私聊「昵称」`, `终端`, or the id itself in backticks when no name is known. */
export function formatTuiChannelLabel(channelId: string, name: string | undefined): string {
	if (channelId === TUI_CHANNEL_ID) return "终端";
	if (!name) return `\`${channelId}\``;
	return parseChannelId(channelId)?.native.startsWith("group:") ? `群「${name}」` : `私聊「${name}」`;
}
