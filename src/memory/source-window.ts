import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export type MemorySourceKind = "idle" | "compaction" | "new-session" | "shutdown";

export interface MemorySourceWindow {
	sourceKind: MemorySourceKind;
	fromEntryId?: string;
	throughEntryId?: string;
	entries: SessionEntry[];
	messages: AgentMessage[];
	windowId: string;
	hasExternalToolContent: boolean;
}

function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function messagesFromEntries(entries: SessionEntry[]): AgentMessage[] {
	return entries.filter(isMessageEntry).map((entry) => entry.message);
}

function hasToolResult(messages: AgentMessage[]): boolean {
	return messages.some(
		(message) =>
			typeof message === "object" && message !== null && "role" in message && message.role === "toolResult",
	);
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
}): MemorySourceWindow {
	const entries = entriesSince(options.entries, options.lastEntryId);
	const entryMessages = messagesFromEntries(entries);
	const messages =
		entryMessages.length > 0 || entries.length > 0 || options.lastEntryId !== undefined
			? entryMessages
			: [...(options.fallbackMessages ?? [])];
	const throughEntryId = entries.at(-1)?.id;
	return {
		sourceKind: options.sourceKind,
		fromEntryId: options.lastEntryId,
		throughEntryId,
		entries,
		messages,
		windowId: createWindowId(options.sourceKind, options.lastEntryId, throughEntryId, messages),
		hasExternalToolContent: hasToolResult(messages),
	};
}

export function buildCompactionMemorySourceWindow(options: {
	entries: SessionEntry[];
	messagesToSummarize: AgentMessage[];
	firstKeptEntryId?: string;
	lastEntryId?: string;
}): MemorySourceWindow {
	const boundaryIndex = options.firstKeptEntryId
		? options.entries.findIndex((entry) => entry.id === options.firstKeptEntryId)
		: -1;
	const coveredEntries = boundaryIndex >= 0 ? options.entries.slice(0, boundaryIndex) : [];
	const incrementalEntries = entriesSince(coveredEntries, options.lastEntryId);
	const throughEntryId = incrementalEntries.at(-1)?.id ?? coveredEntries.at(-1)?.id;
	const incrementalMessages = messagesFromEntries(incrementalEntries);
	const messages =
		incrementalMessages.length > 0 || options.lastEntryId !== undefined
			? incrementalMessages
			: [...options.messagesToSummarize];
	return {
		sourceKind: "compaction",
		fromEntryId: options.lastEntryId,
		throughEntryId,
		entries: incrementalEntries,
		messages,
		windowId: createWindowId("compaction", options.lastEntryId, throughEntryId, messages),
		hasExternalToolContent: hasToolResult(messages),
	};
}
