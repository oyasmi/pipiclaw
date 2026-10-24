/**
 * How a turn's events read as a DingTalk progress card: one line per entry, prefixed by what kind
 * of entry it is (`➜` a tool call, `✦` thinking, `✕` an error, plain text for the model's own
 * words).
 */
export type ProgressEntryKind = "tool" | "thinking" | "error" | "assistant";

function sanitizeProgressText(text: string): string {
	return text.replace(/￼/g, "").replace(/\r/g, "").trim();
}

/** `""` when there is nothing to show. */
export function formatProgressEntry(kind: ProgressEntryKind, text: string): string {
	const cleaned = sanitizeProgressText(text);
	if (!cleaned) return "";

	const normalized = cleaned.replace(/\n+/g, " ").trim();
	switch (kind) {
		case "tool":
			return `➜ ${normalized}`;
		case "thinking":
			return `✦ ${normalized}`;
		case "error":
			return `✕ ${normalized}`;
		case "assistant":
			return normalized;
	}
}
