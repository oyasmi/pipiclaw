/**
 * Locally owned progress cycles. Full mode grows to the document budget; rolling keeps recent
 * activities. Epochs distinguish a replacement from growth, even when retained text is identical.
 * Writes contain only acknowledged-prefix deltas, bounded to complete markdown list items.
 */
export const CARD_REQUEST_MAX_BYTES = 1000;
export const CARD_DOCUMENT_MAX_BYTES = 2900;
const ROLLING_WINDOW_SIZE = 5;
const RETAINED_ACTIVITIES = 2;
const LINE_BYTES = 180;
// Reserve enough room for all five rolling entries plus their newlines in one snapshot.
const HEADER_BYTES = CARD_REQUEST_MAX_BYTES - ROLLING_WINDOW_SIZE * (LINE_BYTES + 1);
const ELLIPSIS = "…";

/** A line already classified by the delivery controller. `tail` keeps the end of the text. */
export interface ProgressActivity {
	marker: "" | "➜" | "✕" | "✦";
	text: string;
	tail?: boolean;
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

/** One bounded, complete list item; long model text cannot cause a sudden height jump. */
export function renderProgressLine(activity: ProgressActivity, maxBytes = LINE_BYTES): string {
	const text = markedLine(activity.marker, activity.text, Math.max(0, maxBytes - 2), activity.tail === true);
	if (!text) return "";
	const line = listItem(text);
	if (byteLength(line) > maxBytes || !isCompleteMarkdownList(line)) return "";
	return line;
}

export interface ProgressFrame {
	epoch: number;
	content: string;
}

export interface ProgressWrite extends ProgressFrame {
	append: boolean;
	/** The document acknowledged if this write succeeds, including any prior prefix. */
	document: string;
	complete: boolean;
}

/** Take a request-sized prefix without cutting a list item or UTF-8 character. */
function requestPrefix(content: string): string {
	const lines: string[] = [];
	for (const line of content.split("\n")) {
		if (byteLength([...lines, line].join("\n")) > CARD_REQUEST_MAX_BYTES) break;
		lines.push(line);
	}
	return lines.join("\n");
}

/** Desired view independent of an in-flight write; old cycles never remain in a replay queue. */
export class ProgressWindow {
	private thinking = "";
	private activities: Array<{ line: string; thinking: boolean }> = [];
	private epoch = 0;
	private header = "";

	constructor(private readonly style: "full" | "rolling") {}

	get hasContent(): boolean {
		return this.activities.length > 0;
	}

	record(activity: ProgressActivity): boolean {
		const line = renderProgressLine(activity);
		if (!line || line === this.activities.at(-1)?.line) return false;
		const thinking = activity.marker === "✦";
		if (thinking) this.thinking = line;
		this.activities.push({ line, thinking });
		if (this.style === "rolling" && this.activities.length > ROLLING_WINDOW_SIZE) {
			this.activities = this.activities.slice(-ROLLING_WINDOW_SIZE);
			this.restart();
		} else if (byteLength(this.body()) > CARD_DOCUMENT_MAX_BYTES) {
			// Bound storage while HTTP is stalled too. Render also accounts for the header.
			this.rebase();
		}
		return true;
	}

	plan(header: string, acknowledged: ProgressFrame, append: boolean): ProgressWrite | undefined {
		// Without append support, a full cycle must fit in one snapshot. Its header can refresh
		// freely; otherwise it stays stable until replacement so ordinary growth is a prefix.
		if (!append) this.header = "";
		this.header ||= renderProgressLine({ marker: "", text: header }, HEADER_BYTES);
		const maxBytes = append ? CARD_DOCUMENT_MAX_BYTES : CARD_REQUEST_MAX_BYTES;
		if (byteLength(`${this.header}\n${this.body()}`) > maxBytes) {
			this.rebase();
			this.header = renderProgressLine({ marker: "", text: header }, HEADER_BYTES);
		}
		const frame = `${this.header}\n${this.body()}`;
		const canAppend = append && acknowledged.epoch === this.epoch && frame.startsWith(acknowledged.content);
		const delta = canAppend ? frame.slice(acknowledged.content.length) : frame;
		if (!delta) return undefined;
		const content = requestPrefix(delta);
		const document = canAppend ? acknowledged.content + content : content;
		return { epoch: this.epoch, content, append: canAppend, document, complete: document === frame };
	}

	/** An ambiguous append is recovered with a short replacement, never by replaying its delta. */
	rebase(): void {
		if (this.style === "full") {
			const recent = this.activities.filter((activity) => !activity.thinking).slice(-RETAINED_ACTIVITIES);
			this.activities = this.thinking ? [{ line: this.thinking, thinking: true }, ...recent] : recent;
		}
		this.restart();
	}

	private restart(): void {
		this.epoch++;
		this.header = "";
	}

	private body(): string {
		return this.activities.map((activity) => activity.line).join("\n");
	}
}

/** A one-line card ending. Falls back to a fixed line if the text could not stay plain markdown. */
export function renderCardStatus(text: string): string {
	const line = inert(text);
	if (line && byteLength(line) <= CARD_REQUEST_MAX_BYTES && !/```|`|\[|\]|\\|[<>]|[*_~]{2}/.test(line)) return line;
	return "处理已结束。";
}
