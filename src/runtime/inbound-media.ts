/**
 * Pure parsing + magic-byte sniffing for DingTalk inbound image attachments (spec 049).
 *
 * Kept separate from `dingtalk.ts` — which owns the network calls (`downloadMessageFile`) and
 * the per-channel serialization of the download — so the message-shape parsing and the sniffing
 * rules can be unit tested without a `DingTalkBot` instance or any I/O.
 */
import { MAX_INBOUND_IMAGE_BYTES } from "../channel/channel-event.js";

/** Re-exported for `dingtalk.ts`'s convenience — see `channel-event.ts` for why the constant
 *  itself lives there rather than here. */
export { MAX_INBOUND_IMAGE_BYTES };

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

/** Defensive hard cap on how many images one inbound message can carry. */
export const MAX_INBOUND_IMAGES_PER_MESSAGE = 9;
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

/**
 * Identify a downloaded file's real format from its magic bytes rather than trusting the
 * `Content-Type` DingTalk's CDN happens to answer with (spec 049 D8) — the four formats `read`
 * and outbound `send_media` already treat as images. `null` means "downloaded fine, but not a
 * recognized image format"; the caller still persists the bytes but never hands them to a model.
 */
export function sniffImageMimeType(data: Buffer): string | null {
	if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
		return "image/jpeg";
	}
	if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return "image/png";
	}
	if (data.length >= 6) {
		const header = data.subarray(0, 6).toString("latin1");
		if (header === "GIF87a" || header === "GIF89a") return "image/gif";
	}
	if (
		data.length >= 12 &&
		data.subarray(0, 4).toString("latin1") === "RIFF" &&
		data.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return "image/webp";
	}
	return null;
}

/** File extension to persist a downloaded attachment under, from its sniffed MIME type. */
export function extensionForMimeType(mimeType: string | null): string {
	switch (mimeType) {
		case "image/jpeg":
			return "jpg";
		case "image/png":
			return "png";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		default:
			return "bin";
	}
}
