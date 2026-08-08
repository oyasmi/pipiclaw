import type { ProgressEntryKind } from "./types.js";

function sanitizeProgressText(text: string): string {
	return text
		.replace(/\uFFFC/g, "")
		.replace(/\r/g, "")
		.trim();
}

/**
 * Head + tail of an over-length message, with the middle replaced by a marker.
 *
 * `fullTextPath` matters more than it looks: the dropped middle of a pasted build log is exactly
 * where the failing stack trace lives, so a marker that only says "omitted" hands the model a
 * mutilated input and no way to notice. When the caller managed to persist the original, the
 * marker names it and says how to read it (the same next-step rule every other truncated output
 * in this runtime follows).
 */
export function clipUserInput(text: string, maxChars: number, fullTextPath?: string): string {
	const normalized = text.replace(/\r/g, "").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}

	const headChars = Math.floor(maxChars * 0.6);
	const tailChars = maxChars - headChars;
	const recovery = fullTextPath
		? `; the complete message is saved at ${fullTextPath} — page through it with the read tool before drawing conclusions about the omitted part`
		: "";
	return `${normalized.slice(0, headChars)}\n\n[... omitted ${normalized.length - maxChars} chars${recovery} ...]\n\n${normalized.slice(-tailChars)}`;
}

export function formatProgressEntry(kind: ProgressEntryKind, text: string): string {
	const cleaned = sanitizeProgressText(text);
	if (!cleaned) return "";

	const normalized = cleaned.replace(/\n+/g, " ").trim();
	switch (kind) {
		case "tool":
			return `▸ ${normalized}`;
		case "thinking":
			return `💭 ${normalized}`;
		case "error":
			return `⚠ ${normalized}`;
		case "assistant":
			return normalized;
	}
}

export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result) ?? String(result);
}
