/**
 * The format of a channel id — the one place it is defined (spec 061, D10). A channel id is an
 * address only: a JSON key, a record field, a log field. It is never a path segment (INV-3).
 *
 * `<transport>:<native>`: everything before the first colon names the transport, everything after
 * it is the transport's own address and is never interpreted here. A DingTalk conversation id is
 * base64 and routinely contains `/`, `+`, `=` and can even contain `:`, which is why only the
 * first colon is ever split.
 */
export interface ParsedChannelId {
	/** The text before the first colon; not validated against the known transports (a stale record may name a retired one). */
	transport: string;
	native: string;
}

/** `dingtalk:dm:abc` → `{ transport: "dingtalk", native: "dm:abc" }`; `undefined` when either side is empty or there is no colon. */
export function parseChannelId(channelId: string): ParsedChannelId | undefined {
	const colon = channelId.indexOf(":");
	if (colon <= 0) return undefined;
	const native = channelId.slice(colon + 1);
	if (!native || native.includes("\0")) return undefined;
	return { transport: channelId.slice(0, colon), native };
}

export function transportOf(channelId: string): string | undefined {
	return parseChannelId(channelId)?.transport;
}

/** What a report needs to say about a delivery channel: its label, and whether it is still bound to this desk. */
export interface ChannelDescription {
	label: string;
	boundHere: boolean;
}
