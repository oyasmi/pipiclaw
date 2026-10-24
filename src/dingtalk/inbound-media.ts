/**
 * Pure parsing of DingTalk inbound image attachments (spec 049).
 *
 * Kept separate from `dingtalk.ts` — which owns the network calls (`downloadMessageFile`) and
 * the per-channel serialization of the download — so the message-shape parsing rules can be unit tested without a `DingTalkBot` instance or any I/O.
 */
/** Structural subset of the raw DingTalk callback payload this module reads. */
export interface InboundMessagePayload {
	msgtype?: string;
	text?: { content?: string };
	content?: {
		richText?: Array<Record<string, string>>;
		/** Present on a `picture` message; the credential `robot/messageFiles/download` needs. */
		downloadCode?: string;
	};
}

export interface ParsedInboundMessage {
	/**
	 * User text with `[图片N]` markers inserted at each image's position in a richText mix, or a
	 * synthetic `[图片1]` marker for a text-less `picture` message. Empty when the message carries
	 * neither text nor an image — the caller still drops that case.
	 */
	text: string;
	/** In the same order as the `[图片N]` markers in `text`, one entry per image. */
	downloadCodes: string[];
}

/** Mirrors `MEDIA_UPLOAD_TIMEOUT_MS`: a multi-MB download over a slow link needs more than the
 *  15s default HTTP timeout. */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Parse one raw DingTalk callback payload into text + ordered image credentials.
 *
 * - `text` messages: unchanged, no images.
 * - `picture` messages: carry no text of their own; a synthetic `[图片1]` marker stands in so
 *   the turn never becomes a genuinely empty message (spec 049 D4 — `handleBusyMessage` rejects
 *   those, and the runtime warns and drops a truly empty message outright).
 * - `richText` messages: text and image credentials interleave in payload order; each image's
 *   marker is inserted at its position in the text stream so "this picture" / "the one above" in
 *   a follow-up still resolves to the right attachment (D5), even though the SDK's `prompt()`
 *   itself appends every image after all text once the turn is actually sent.
 */
export function parseInboundMessage(data: InboundMessagePayload): ParsedInboundMessage {
	const textContent = (data.text?.content || "").trim();
	if (textContent) {
		return { text: textContent, downloadCodes: [] };
	}

	if (data.msgtype === "picture" && data.content?.downloadCode) {
		return { text: "[图片1]", downloadCodes: [data.content.downloadCode] };
	}

	if (data.content?.richText) {
		const parts: string[] = [];
		const downloadCodes: string[] = [];
		for (const item of data.content.richText) {
			if (item.text) {
				parts.push(item.text);
			} else if (item.downloadCode) {
				downloadCodes.push(item.downloadCode);
				parts.push(`[图片${downloadCodes.length}]`);
			}
		}
		const joined = parts.join("").trim();
		if (joined) {
			return { text: joined, downloadCodes };
		}
	}

	return { text: "", downloadCodes: [] };
}
