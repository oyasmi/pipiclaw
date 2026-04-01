import type { ProgressEntryKind } from "./types.js";

function sanitizeProgressText(text: string): string {
	return text
		.replace(/\uFFFC/g, "")
		.replace(/\r/g, "")
		.trim();
}

export function clipUserInput(text: string, maxChars: number): string {
	const normalized = text.replace(/\r/g, "").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}

	const headChars = Math.floor(maxChars * 0.6);
	const tailChars = maxChars - headChars;
	return `${normalized.slice(0, headChars)}\n\n[... omitted ${normalized.length - maxChars} chars ...]\n\n${normalized.slice(-tailChars)}`;
}

export function formatProgressEntry(kind: ProgressEntryKind, text: string): string {
	const cleaned = sanitizeProgressText(text);
	if (!cleaned) return "";

	const normalized = cleaned.replace(/\n+/g, " ").trim();
	switch (kind) {
		case "tool":
			return `Running: ${normalized}`;
		case "thinking":
			return `Thinking: ${normalized}`;
		case "error":
			return `Error: ${normalized}`;
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

	return JSON.stringify(result);
}
