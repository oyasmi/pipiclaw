import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, type SessionEntry, serializeConversation } from "@earendil-works/pi-coding-agent";
import { clipTextByPromptUnits } from "../../shared/prompt-units.js";

const COMPACTION_INPUT_MAX_UNITS = 48_000;
const COMPACTION_INPUT_MIN_UNITS = 256;

/** Reduce reproducible payloads only in the summary request. Raw JSONL remains authoritative. */
export function reduceSummaryPayloads(
	messages: AgentMessage[],
	entries: SessionEntry[],
	sessionFile?: string,
): AgentMessage[] {
	const ids = new Map(
		entries.flatMap((entry) => (entry.type === "message" ? [[entry.message, entry.id] as const] : [])),
	);
	const payloads = new Map<string, string>();
	return messages.map((message) => {
		const reference = (text: string) => {
			const hash = createHash("sha256").update(text).digest("hex");
			const previous = payloads.get(hash);
			if (previous) return `[Repeated payload; ${previous}]`;
			const locator = `sha256=${hash}; recover the original JSON entry ${ids.get(message) ?? "with matching timestamp"} (timestamp=${"timestamp" in message ? message.timestamp : "unknown"}) in ${sessionFile ?? "the original session JSONL"}. Use session_search with the tool/path identifier, or read that JSONL entry directly.`;
			payloads.set(hash, locator);
			return `${text.slice(0, 600)}\n[Payload omitted; ${locator}]\n${text.slice(-600)}`;
		};
		if (message.role === "toolResult") {
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (text.length > 1800)
				return {
					...message,
					content: [
						{ type: "text", text: reference(text) },
						...message.content.filter((part) => part.type !== "text"),
					],
				};
			return message;
		}
		if (message.role !== "assistant") return message;
		return {
			...message,
			content: message.content.map((part) => {
				if (part.type !== "toolCall") return part;
				return {
					...part,
					arguments: Object.fromEntries(
						Object.entries(part.arguments).map(([key, value]) => [
							key,
							typeof value === "string" && value.length > 4096 ? reference(value) : value,
						]),
					),
				};
			}),
		};
	});
}

/** Cover the entire reduced transcript; excessive work fails closed instead of dropping its middle. */
export function splitSummaryInput(
	messages: AgentMessage[],
	contextWindow: number,
	reserveTokens: number,
): AgentMessage[][] {
	const maxUnits = Math.min(COMPACTION_INPUT_MAX_UNITS, Math.floor(contextWindow - reserveTokens - 4096));
	if (maxUnits < COMPACTION_INPUT_MIN_UNITS)
		throw new Error("Checkpoint cannot fit this model. Use a larger /model or start /new.");
	let remaining = serializeConversation(convertToLlm(messages));
	const chunks: AgentMessage[][] = [];
	while (remaining.length > 0) {
		const part = clipTextByPromptUnits(remaining, maxUnits, {
			headRatio: 1,
			maxChars: maxUnits * 3,
			marker: "",
		}).text;
		if (!part || chunks.length >= 4)
			throw new Error(
				"Checkpoint needs too many summary requests. Use a larger /model or start /new; the original history is retained.",
			);
		chunks.push([{ role: "user", content: part, timestamp: Date.now() }]);
		if (part.length === remaining.length) break;
		// Overlap protects identifiers and sentences crossing a chunk boundary.
		remaining = remaining.slice(Math.max(1, part.length - 256));
	}
	return chunks.length ? chunks : [[]];
}
