import type { AssistantMessage } from "@earendil-works/pi-ai";

export function clipText(
	text: string,
	maxChars: number,
	opts: { headRatio?: number; omitHint?: string; collapseWhitespace?: boolean } = {},
): string {
	const normalized = opts.collapseWhitespace
		? text.replace(/\s+/g, " ").trim()
		: text.replace(/\s+\n/g, "\n").replace(/\r/g, "").trim();
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

/** Append a trailing `/` unless the path already has one — the shared prefix-match building
 * block so `/repo-ab` is never mistaken for a path within `/repo-a`. */
export function withTrailingSlash(path: string): string {
	return path.endsWith("/") ? path : `${path}/`;
}

/** Strip embedded NUL bytes and Unicode-normalize to NFKC — the shared first step every path and
 * shell-command guard applies before pattern matching, so a null-byte truncation trick or a
 * confusable-character encoding cannot slip past the check that runs after it. */
export function stripNullAndNormalize(text: string): string {
	return text.replace(/\0/g, "").normalize("NFKC");
}

/** Strip a trailing `.json` from an event filename to get its logical name. */
export function eventNameFromFilename(filename: string): string {
	return filename.endsWith(".json") ? filename.slice(0, -".json".length) : filename;
}

/** Normalize CRLF to LF and trim surrounding whitespace — the common first step before comparing,
 * hashing, or re-parsing content read from disk. */
export function stripCrAndTrim(content: string): string {
	return content.replace(/\r/g, "").trim();
}

export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
