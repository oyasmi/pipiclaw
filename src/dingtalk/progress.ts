/**
 * Text for the live DingTalk progress card.
 *
 * A live update is one complete markdown list (`isFull: true`) or one extra list item
 * (`isFull: false`). The configured template accepts both. Each request stays within
 * {@link CARD_REQUEST_MAX_BYTES}. Once the next item would carry the card past
 * {@link CARD_DOCUMENT_MAX_BYTES}, the card is replaced by a short snapshot and appending resumes.
 * Dynamic text is made markdown-inert first, and every line is finished before it is cut.
 */
export const CARD_REQUEST_MAX_BYTES = 1000;
export const CARD_DOCUMENT_MAX_BYTES = 2900;
export const CARD_COMPACT_MAX_BYTES = 200;

const LINE_BYTES = 180;
const ELLIPSIS = "…";

/** A line already classified by the delivery controller. `tail` keeps the end of the text. */
export interface ProgressActivity {
	marker: "" | "➜" | "✕" | "✦";
	text: string;
	tail?: boolean;
}

/** The next card write. `drop` discards one queued line that cannot be sent on its own. */
export interface ProgressWrite {
	method: "replace" | "append" | "drop";
	content: string;
	/** The snapshot already stands for every queued line. */
	clearPending: boolean;
}

/**
 * Make one line of model or tool text safe to drop into a markdown list.
 *
 * Fences, backticks, links and angle brackets are rewritten because cutting one in half leaves
 * the document unfinished. A run of emphasis markers (`**`, `__`) is split with a zero-width
 * space so it cannot open a span; a single `*` or `_` stays, which keeps globs and file names.
 */
function inert(text: string): string {
	return text
		.replace(/￼/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
		.replace(/\r/g, "")
		.replace(/\s+/g, " ")
		.replace(/```/g, "")
		.replace(/`/g, "'")
		.replace(/\[/g, "［")
		.replace(/\]/g, "］")
		.replace(/\\/g, "＼")
		.replace(/</g, "＜")
		.replace(/>/g, "＞")
		.replace(/([*_~])\1+/g, (run) => [...run].join("\u200b"))
		.trim();
}

function byteLength(text: string): number {
	return Buffer.byteLength(text);
}

function clip(text: string, maxBytes: number, tail: boolean): string {
	if (byteLength(text) <= maxBytes) return text;
	const budget = maxBytes - byteLength(ELLIPSIS);
	if (budget <= 0) return "";
	let kept = "";
	const chars = [...text];
	if (tail) {
		for (let index = chars.length - 1; index >= 0; index--) {
			const next = `${chars[index] ?? ""}${kept}`;
			if (byteLength(next) > budget) break;
			kept = next;
		}
		return kept ? `${ELLIPSIS}${kept}` : "";
	}
	for (const char of chars) {
		const next = `${kept}${char}`;
		if (byteLength(next) > budget) break;
		kept = next;
	}
	return kept ? `${kept}${ELLIPSIS}` : "";
}

function markedLine(marker: string, text: string, maxBytes: number, tail: boolean): string {
	const body = inert(text);
	if (!body) return "";
	const prefix = marker ? `${marker} ` : "";
	const clipped = clip(body, Math.max(0, maxBytes - byteLength(prefix)), tail);
	if (!clipped) return "";
	return `${prefix}${clipped}`;
}

function listItem(text: string): string {
	return `- ${text}`;
}

/** A tight list whose lines cannot leave a fence, link, or emphasis span open. */
function isCompleteMarkdownList(frame: string): boolean {
	if (/```|`|\[|\]|\\|[<>]|[*_~]{2}/.test(frame)) return false;
	const lines = frame.split("\n");
	return lines.length > 0 && lines.every((line) => line.startsWith("- ") && line === line.trim() && line.length > 2);
}

/** One list item, sized so a request that prefixes a newline still fits in one update. */
export function renderProgressLine(activity: ProgressActivity, maxBytes = CARD_REQUEST_MAX_BYTES - 1): string {
	const text = markedLine(activity.marker, activity.text, Math.max(0, maxBytes - 2), activity.tail === true);
	if (!text) return "";
	const line = listItem(text);
	if (byteLength(line) > maxBytes || !isCompleteMarkdownList(line)) return "";
	return line;
}

/**
 * One complete markdown list: a header, the latest thinking excerpt, then the activity window.
 * Lines are dropped whole, then shortened, until the frame fits `maxBytes`.
 */
export function renderProgressFrame(input: {
	header: string;
	thinking?: string;
	activities: ProgressActivity[];
	maxBytes?: number;
}): string {
	const maxBytes = input.maxBytes ?? CARD_REQUEST_MAX_BYTES;
	const headerLine = listItem(inert(input.header) || "正在处理…");
	let thinkingBudget = Math.min(LINE_BYTES, maxBytes);
	let lineBudget = Math.min(LINE_BYTES, maxBytes);
	let activities = input.activities.filter((activity) => inert(activity.text));

	const build = (): string => {
		const lines = [headerLine];
		if (input.thinking) {
			const thinking = markedLine("✦", input.thinking, thinkingBudget, true);
			if (thinking) lines.push(listItem(thinking));
		}
		for (const activity of activities) {
			const line = markedLine(activity.marker, activity.text, lineBudget, activity.tail === true);
			if (line) lines.push(listItem(line));
		}
		return lines.join("\n");
	};

	let frame = build();
	while (byteLength(frame) > maxBytes && activities.length > 1) {
		activities = activities.slice(1);
		frame = build();
	}
	while (byteLength(frame) > maxBytes && thinkingBudget > 24) {
		thinkingBudget = Math.floor(thinkingBudget * 0.6);
		frame = build();
	}
	while (byteLength(frame) > maxBytes && lineBudget > 24) {
		lineBudget = Math.floor(lineBudget * 0.6);
		frame = build();
	}
	while (byteLength(frame) > maxBytes && activities.length > 0) {
		activities = activities.slice(1);
		frame = build();
	}
	if (byteLength(frame) <= maxBytes && isCompleteMarkdownList(frame)) return frame;
	if (byteLength(headerLine) <= maxBytes && isCompleteMarkdownList(headerLine)) return headerLine;
	return "- 正在处理…";
}

/**
 * The first real progress frame. It replaces the warmup line instead of appending onto it, and
 * it keeps only the queued items that fit in one request. The rest stay queued for append.
 */
export function renderOpeningFrame(header: string, pending: readonly string[]): string {
	const head = renderProgressLine({ marker: "", text: header });
	const lines: string[] = [];
	if (head) lines.push(head);
	for (const line of pending) {
		const candidate = [...lines, line].join("\n");
		if (byteLength(candidate) > CARD_REQUEST_MAX_BYTES) break;
		lines.push(line);
	}
	const frame = lines.join("\n");
	if (frame && byteLength(frame) <= CARD_REQUEST_MAX_BYTES && isCompleteMarkdownList(frame)) return frame;
	return head && byteLength(head) <= CARD_REQUEST_MAX_BYTES ? head : "- 正在处理…";
}

/**
 * Choose the next progress write. Appending continues while the card stays under the document
 * ceiling; crossing it sends the short snapshot first. With append unavailable, every update is
 * one snapshot that already fits in a single request.
 */
export function planProgressWrite(input: {
	document: string;
	pending: readonly string[];
	append: boolean;
	header: string;
	fallback: string;
	compact: string;
}): ProgressWrite | undefined {
	const pending = input.pending.filter((line) => line.trim());
	if (pending.length === 0) return undefined;
	if (!input.append) {
		if (!input.fallback || input.fallback === input.document) return undefined;
		return { method: "replace", content: input.fallback, clearPending: true };
	}
	if (!input.document) {
		const opening = renderOpeningFrame(input.header, pending);
		if (!opening) return undefined;
		return { method: "replace", content: opening, clearPending: false };
	}
	const delta = `\n${pending[0]}`;
	if (byteLength(delta) > CARD_REQUEST_MAX_BYTES) return { method: "drop", content: "", clearPending: false };
	if (byteLength(input.document) + byteLength(delta) > CARD_DOCUMENT_MAX_BYTES) {
		if (!input.compact || input.compact === input.document)
			return { method: "drop", content: "", clearPending: false };
		return { method: "replace", content: input.compact, clearPending: false };
	}
	return { method: "append", content: delta, clearPending: false };
}

/** A one-line card ending. Falls back to a fixed line if the text could not stay plain markdown. */
export function renderCardStatus(text: string): string {
	const line = inert(text);
	if (line && byteLength(line) <= CARD_REQUEST_MAX_BYTES && !/```|`|\[|\]|\\|[<>]|[*_~]{2}/.test(line)) return line;
	return "处理已结束。";
}
