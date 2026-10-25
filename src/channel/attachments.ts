/**
 * What every transport shares about inbound attachments (spec 061, D5): the size and count limits,
 * and magic-byte identification of image bytes. A transport only downloads or decodes bytes and
 * checks these limits; persisting them under the bound desk's `inbox/` is the runtime's job.
 */

/**
 * Inbound has no transport-imposed size contract the way outbound does. This is the limit a user's
 * picture is accepted under, deliberately above `tools/truncate.ts`'s `MAX_INLINE_BINARY_BYTES`
 * (what `read` inlines from disk): a sent photo is the user's own input, and today's vision models
 * accept it. Lives in `channel/` because both a transport (rejecting an oversized
 * download) and `agent/` (skipping an oversized file before base64-encoding it) need the same
 * number, and `agent/` never imports from `runtime/` (spec 049).
 */
export const MAX_INBOUND_IMAGE_BYTES = 10 * 1024 * 1024;

/** Defensive hard cap on how many images one inbound message can carry. */
export const MAX_INBOUND_IMAGES_PER_MESSAGE = 10;

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
