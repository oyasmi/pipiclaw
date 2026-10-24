/**
 * How the terminal writes a progress entry: one line, prefixed by what kind of entry it is. A copy
 * of the DingTalk card's own convention (`dingtalk/progress.ts`) because the two transports never
 * import each other; it goes away when the terminal becomes a Web API client (spec 061, C1).
 */
export type ProgressEntryKind = "tool" | "thinking" | "error" | "assistant";

/** `""` when there is nothing to show. */
export function formatProgressEntry(kind: ProgressEntryKind, text: string): string {
	const cleaned = text.replace(/￼/g, "").replace(/\r/g, "").trim();
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
