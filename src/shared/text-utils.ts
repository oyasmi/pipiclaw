import type { AssistantMessage } from "@mariozechner/pi-ai";

export function clipText(
	text: string,
	maxChars: number,
	opts: { headRatio?: number; omitHint?: string } = {},
): string {
	const normalized = text.replace(/\s+\n/g, "\n").replace(/\r/g, "").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}

	const headRatio = Math.max(0, Math.min(1, opts.headRatio ?? 0.45));
	const omitHint = opts.omitHint ?? "[... omitted middle section ...]";
	if (headRatio >= 1) {
		const headChars = Math.max(0, maxChars - omitHint.length);
		return `${normalized.slice(0, headChars).trimEnd()}${omitHint}`;
	}

	const headChars = Math.floor(maxChars * headRatio);
	const tailChars = maxChars - headChars;
	return `${normalized.slice(0, headChars)}\n\n${omitHint}\n\n${normalized.slice(-tailChars)}`;
}

export function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) {
		return text;
	}
	return `${text.substring(0, maxLen - 3)}...`;
}

export const HAN_REGEX = /\p{Script=Han}/u;

export function extractLabelFromArgs(args: unknown): string | null {
	if (!args || typeof args !== "object" || !("label" in args)) {
		return null;
	}
	const label = (args as { label?: unknown }).label;
	return typeof label === "string" && label.trim() ? label.trim() : null;
}

export function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter(
			(part): part is Extract<AssistantMessage["content"][number], { type: "text"; text: string }> =>
				part.type === "text",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}
