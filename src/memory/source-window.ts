import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type SessionEntry, serializeConversation } from "@earendil-works/pi-coding-agent";
import { messageText, sanitizeMessagesForMemory } from "./transcript.js";

export const MEMORY_TRANSCRIPT_MAX_CHARS = 28_000;

export type MemorySourceKind = "idle" | "compaction" | "new-session" | "shutdown";

export interface MemorySourceWindow {
	sourceKind: MemorySourceKind;
	fromEntryId?: string;
	throughEntryId?: string;
	entries: SessionEntry[];
	messages: AgentMessage[];
	windowId: string;
	hasMore: boolean;
	/** An indivisible exchange exceeds the budget and will be explicitly sampled. */
	sampledChars: number;
}

interface SourceEntry {
	id: string;
	message?: AgentMessage;
}

/** Select a contiguous prefix of complete exchanges; never acknowledge a trailing unanswered user. */
export function selectMemorySourceBatch<T extends SourceEntry>(
	entries: T[],
	closed = false,
): {
	entries: T[];
	messages: AgentMessage[];
	hasMore: boolean;
	sampledChars: number;
} {
	const ends: number[] = [];
	let groupStart = 0;
	let userSeen = false;
	let answered = false;
	for (let index = 0; index < entries.length; index++) {
		const raw = entries[index].message;
		const message = raw ? sanitizeMessagesForMemory([raw])[0] : undefined;
		if (!message || !messageText(message).trim()) continue;
		if (message.role === "user") {
			if (userSeen && answered) {
				ends.push(index);
				groupStart = index;
				answered = false;
			}
			userSeen = true;
		} else if (message.role === "assistant" && userSeen) answered = true;
	}
	const openTail = !closed && userSeen && !answered;
	const end = openTail ? groupStart : entries.length;
	if (end > (ends.at(-1) ?? 0)) ends.push(end);
	let count = 0;
	let messages: AgentMessage[] = [];
	let size = 0;
	for (const candidate of ends) {
		const next = entries.slice(0, candidate).flatMap((entry) => (entry.message ? [entry.message] : []));
		const chars = serializeConversation(sanitizeMessagesForMemory(next)).length;
		if (count > 0 && chars > MEMORY_TRANSCRIPT_MAX_CHARS) break;
		count = candidate;
		messages = next;
		size = chars;
		if (chars > MEMORY_TRANSCRIPT_MAX_CHARS) break;
	}
	return {
		entries: entries.slice(0, count),
		messages,
		hasMore: count < entries.length,
		sampledChars: size > MEMORY_TRANSCRIPT_MAX_CHARS ? size : 0,
	};
}

function createWindowId(
	sourceKind: MemorySourceKind,
	fromEntryId: string | undefined,
	throughEntryId: string | undefined,
	messages: AgentMessage[],
): string {
	const fallbackFingerprint =
		throughEntryId === undefined
			? createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16)
			: "";
	return createHash("sha256")
		.update([sourceKind, fromEntryId ?? "start", throughEntryId ?? fallbackFingerprint].join("\0"))
		.digest("hex")
		.slice(0, 20);
}

export function entriesSince(entries: SessionEntry[], lastEntryId: string | undefined): SessionEntry[] {
	if (!lastEntryId) {
		return [...entries];
	}
	const index = entries.findIndex((entry) => entry.id === lastEntryId);
	return index >= 0 ? entries.slice(index + 1) : [...entries];
}

export function buildIncrementalMemorySourceWindow(options: {
	entries: SessionEntry[];
	lastEntryId?: string;
	sourceKind: Extract<MemorySourceKind, "idle" | "new-session" | "shutdown">;
	fallbackMessages?: AgentMessage[];
	closed?: boolean;
}): MemorySourceWindow {
	const remaining = entriesSince(options.entries, options.lastEntryId);
	const batch = selectMemorySourceBatch(
		remaining.map((entry) => ({
			...entry,
			message: entry.type === "message" ? entry.message : undefined,
		})),
		options.closed,
	);
	const entries = remaining.slice(0, batch.entries.length);
	const messages =
		remaining.length > 0 || options.lastEntryId !== undefined
			? batch.messages
			: [...(options.fallbackMessages ?? [])];
	const throughEntryId = entries.at(-1)?.id;
	return {
		sourceKind: options.sourceKind,
		fromEntryId: options.lastEntryId,
		throughEntryId,
		entries,
		messages,
		windowId: createWindowId(options.sourceKind, options.lastEntryId, throughEntryId, messages),
		hasMore: batch.hasMore,
		sampledChars: batch.sampledChars,
	};
}
