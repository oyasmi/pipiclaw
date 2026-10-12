/**
 * A shared length cap for command replies (review 2026-08-24 §1.8/§3.3 rule 5): DingTalk has no
 * client-side scrolling affordance for a long plain message, so an unbounded list/report reads as
 * a wall of text on mobile. Cuts on a line boundary — never mid-line — and always leaves the
 * caller's own "how to see the rest" hint instead of silently dropping content.
 */

export interface CapReplyOptions {
	maxChars?: number;
	/** What to tell the user to do next, e.g. "用更具体的筛选缩小范围" or "用 `/tasks show <id>` 查看完整内容". */
	nextStepHint: string;
}

export interface CapReplyResult {
	text: string;
	truncated: boolean;
}

const DEFAULT_MAX_CHARS = 1500;

export function capReply(text: string, options: CapReplyOptions): CapReplyResult {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}

	const lastNewline = text.lastIndexOf("\n", maxChars);
	const cut = lastNewline > 0 ? lastNewline : maxChars;
	const head = text.slice(0, cut).trimEnd();
	return { text: `${head}\n\n（内容过长已截断；${options.nextStepHint}）`, truncated: true };
}

/**
 * Reshape a markdown file for a chat reply (rule 3/4): `#` headings become a bold line and
 * indentation is dropped, since DingTalk keeps neither. Fenced code blocks pass through as-is.
 * Used where a reply quotes a file the user wrote (a task contract, a skill body).
 */
export function flattenMarkdownForChat(text: string): string {
	const out: string[] = [];
	let fenced = false;
	for (const raw of text.split("\n")) {
		if (/^\s*```/.test(raw)) {
			fenced = !fenced;
			out.push(raw.trim());
			continue;
		}
		if (fenced) {
			out.push(raw);
			continue;
		}
		const trimmed = raw.trim();
		const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
		out.push(heading ? `**${heading[1]}**` : trimmed);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
