import { homedir } from "node:os";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import { buildStandardMessages } from "../shared/type-guards.js";
import { redactSecrets } from "./secret-redaction.js";

const URL = /https?:\/\/[^\s<>"'`）)】\]，；：！？。]+/giu;
const SEGMENT = String.raw`[\p{L}\p{N}_@%+~.-]+`;
const PATH = new RegExp(
	String.raw`(?<![\w./~$-])(?:(?:~|\$HOME)?/(?:${SEGMENT}/)+${SEGMENT}|(?:${SEGMENT}/)+${SEGMENT}\.[a-z0-9]{1,8}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}]))`,
	"giu",
);
const HOST_PORT = /\b(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+):\d{2,5}\b/gi;
const LABELLED_PORT = /(?:端口\s*|\bport\s+)(\d{2,5})(?!\d)/gi;
const VERSION = /\b(?:v\d+(?:\.\d+)+|\d+(?:\.\d+){2,})\b/g;
const COMMIT = /\b(?=[a-f\d]*[a-f])(?=[a-f\d]*\d)[a-f\d]{7,40}\b/gi;
const TERMINAL_PUNCTUATION = /[.,;:!?。，；：！？]+$/u;
const CSS_RATIO = /^\d+(?:px|rem|em|pt)\/\d+\.\d+$/i;

export function extractAnchors(text: string): string[] {
	const hits: Array<{ offset: number; value: string }> = [];
	let remaining = text.normalize("NFKC");
	// Mask composite identifiers before looking for paths, hashes, versions, or port numbers
	// embedded inside them. Preserve offsets so the first unsupported anchor is deterministic.
	for (const pattern of [URL, PATH, HOST_PORT, LABELLED_PORT, VERSION, COMMIT]) {
		for (const match of remaining.matchAll(pattern)) {
			if (pattern === PATH && CSS_RATIO.test(match[0])) continue;
			const value = (match[1] ?? match[0]).replace(TERMINAL_PUNCTUATION, "");
			hits.push({ offset: match.index, value });
		}
		remaining = remaining.replaceAll(pattern, (match) => " ".repeat(match.length));
	}
	return [...new Set(hits.sort((a, b) => a.offset - b.offset).map(({ value }) => value))];
}

function anchorForms(anchor: string, home: string): string[] {
	if (/^https?:\/\//i.test(anchor)) {
		const stem = anchor.replace(/\/$/, "");
		return [stem, `${stem}/`];
	}
	const homePrefix = `${home.replace(/\/$/, "")}/`;
	const prefix = ["~/", "$HOME/", homePrefix].find((candidate) => anchor.startsWith(candidate));
	if (!prefix) return [anchor];
	const rest = anchor.slice(prefix.length);
	return [`~/${rest}`, `$HOME/${rest}`, `${homePrefix}${rest}`];
}

export function findUnanchored(anchors: string[], provenance: string, home = homedir()): string[] {
	const source = provenance.normalize("NFKC");
	return anchors.filter((anchor) => !anchorForms(anchor, home).some((form) => source.includes(form)));
}

/** Tool output in the same source window can corroborate an identifier without entering the prompt. */
export function toolResultProvenance(messages: AgentMessage[]): string[] {
	return buildStandardMessages(messages).flatMap((message) =>
		message.role === "toolResult" ? [redactSecrets(contentText(message.content))] : [],
	);
}
