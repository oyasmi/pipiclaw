import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import {
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionMessageEntry,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { parseJsonObject } from "./llm-json.js";
import {
	appendChannelHistoryBlock,
	appendChannelMemoryUpdate,
	readChannelHistory,
	readChannelMemory,
	readChannelSession,
	rewriteChannelHistory,
	rewriteChannelMemory,
	splitMarkdownSections,
} from "./memory-files.js";
import { clipText } from "./shared/text-utils.js";
import { buildStandardMessages } from "./shared/type-guards.js";
import { runSidecarTask } from "./sidecar-worker.js";

const INLINE_TRANSCRIPT_MAX_CHARS = 28_000;
const MEMORY_CLEANUP_LENGTH_THRESHOLD = 8_000;
const MEMORY_UPDATE_BLOCK_THRESHOLD = 6;
const HISTORY_LENGTH_THRESHOLD = 16_000;
const HISTORY_BLOCK_THRESHOLD = 8;
const HISTORY_RECENT_BLOCKS_TO_KEEP = 4;
const INLINE_CONSOLIDATION_TIMEOUT_MS = 20_000;
const MEMORY_CLEANUP_TIMEOUT_MS = 30_000;
const HISTORY_FOLDING_TIMEOUT_MS = 30_000;

const INLINE_CONSOLIDATION_SYSTEM_PROMPT = `You are a runtime memory consolidation worker for Pipiclaw.

Return strict JSON only. Do not wrap in Markdown fences.

Output schema:
{
  "memoryEntries": ["string"],
  "historyBlock": "string"
}

Rules:
- memoryEntries: concise durable facts, decisions, preferences, constraints, current work state, or open loops that should survive compaction.
- Each memoryEntries item must be a standalone sentence fragment suitable for a Markdown bullet without the bullet prefix.
- Do not include raw transcript quotes unless essential.
- Do not include ephemeral chatter, obvious one-shot acknowledgements, or formatting instructions.
- Prefer leaving highly volatile step-by-step execution state in SESSION.md rather than promoting it into durable memory.
- historyBlock: concise Markdown summarizing the conversation chunk for later recovery.
- Prefer short bullets and short paragraphs.
- If there is nothing worth storing, return empty values.`;

const MEMORY_CLEANUP_SYSTEM_PROMPT = `You are rewriting a Pipiclaw channel MEMORY.md file.

Return Markdown only. Do not use code fences.

Goals:
- Keep only durable and useful channel memory.
- Remove outdated entries, duplicates, and verbose phrasing.
- Organize the result with stable sections where relevant.
- Prefer concise bullets over prose.
- Remove content that is clearly transient session-state and belongs in SESSION.md instead.

Suggested sections:
- ## Identity / Participants
- ## Preferences
- ## Ongoing Work
- ## Constraints
- ## Decisions
- ## Open Loops

Omit empty sections.`;

const HISTORY_FOLDING_SYSTEM_PROMPT = `You are folding older HISTORY.md blocks for Pipiclaw.

Return Markdown only. Do not use code fences.

Goals:
- Compress older history blocks into one concise summary block.
- Keep important decisions, milestones, and unresolved outcomes.
- Remove redundancy and transcript-like detail.
- Preserve a chronological narrative at a high level.`;

export interface ConsolidationRunOptions {
	channelDir: string;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	messages: AgentMessage[];
	sessionEntries?: SessionEntry[];
}

export interface InlineConsolidationResult {
	skipped: boolean;
	appendedMemoryEntries: number;
	appendedHistoryBlock: boolean;
}

export interface BackgroundMaintenanceResult {
	cleanedMemory: boolean;
	foldedHistory: boolean;
}

interface ConsolidationResponse {
	memoryEntries: string[];
	historyBlock: string;
}

function normalizeText(text: string): string {
	return text.replace(/\r/g, "").trim();
}

function parseConsolidationResponse(text: string): ConsolidationResponse {
	const parsed = parseJsonObject(text) as Partial<ConsolidationResponse>;
	return {
		memoryEntries: Array.isArray(parsed.memoryEntries)
			? parsed.memoryEntries
					.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
					.filter((entry) => entry.length > 0)
			: [],
		historyBlock: typeof parsed.historyBlock === "string" ? parsed.historyBlock.trim() : "",
	};
}

function getLatestCompactionBoundary(entries: SessionEntry[]): number {
	const latestCompaction = getLatestCompactionEntry(entries);
	if (!latestCompaction) {
		return 0;
	}

	const boundaryIndex = entries.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId);
	return boundaryIndex >= 0 ? boundaryIndex : 0;
}

function isMessage(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function extractMessagesFromSessionEntries(entries: SessionEntry[]): AgentMessage[] {
	return entries.filter(isMessage).map((entry) => entry.message);
}

function hasMeaningfulMessages(messages: Message[]): boolean {
	let meaningfulCount = 0;
	for (const message of messages) {
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
			if (text.trim()) meaningfulCount++;
		} else if (message.role === "assistant") {
			const text = message.content
				.filter(
					(part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text",
				)
				.map((part) => part.text)
				.join("\n");
			if (text.trim()) meaningfulCount++;
		}
		if (meaningfulCount >= 2) {
			return true;
		}
	}
	return false;
}

function countMatchingSectionHeadings(content: string, prefix: string): number {
	return splitMarkdownSections(content).filter((section) => section.heading.startsWith(prefix)).length;
}

async function runWorkerPrompt(
	name: string,
	model: Model<Api>,
	resolveApiKey: (model: Model<Api>) => Promise<string>,
	systemPrompt: string,
	prompt: string,
	timeoutMs: number,
): Promise<string> {
	const result = await runSidecarTask({
		name,
		model,
		resolveApiKey,
		systemPrompt,
		prompt,
		timeoutMs,
		parse: (text) => text.trim(),
	});
	return result.output;
}

async function buildInlineConsolidationResponse(
	options: ConsolidationRunOptions,
	messages: Message[],
): Promise<ConsolidationResponse> {
	const transcript = clipText(serializeConversation(messages), INLINE_TRANSCRIPT_MAX_CHARS, { headRatio: 0.35 });
	const currentMemory = clipText(await readChannelMemory(options.channelDir), 8_000, { headRatio: 0.35 });
	const currentSession = clipText(await readChannelSession(options.channelDir), 8_000, { headRatio: 0.35 });
	const currentHistory = clipText(await readChannelHistory(options.channelDir), 8_000, { headRatio: 0.35 });

	const prompt = `Current SESSION.md:
${currentSession || "(empty)"}

Channel memory file:
${currentMemory || "(empty)"}

Channel history file:
${currentHistory || "(empty)"}

Conversation chunk to persist:
${transcript || "(empty)"}`;

	const rawResponse = await runWorkerPrompt(
		"memory-inline-consolidation",
		options.model,
		options.resolveApiKey,
		INLINE_CONSOLIDATION_SYSTEM_PROMPT,
		prompt,
		INLINE_CONSOLIDATION_TIMEOUT_MS,
	);
	return parseConsolidationResponse(rawResponse);
}

export async function runInlineConsolidation(options: ConsolidationRunOptions): Promise<InlineConsolidationResult> {
	const sourceEntries = options.sessionEntries ?? [];
	const relevantEntries =
		sourceEntries.length > 0 ? sourceEntries.slice(getLatestCompactionBoundary(sourceEntries)) : sourceEntries;
	const relevantMessages = buildStandardMessages(
		relevantEntries.length > 0 ? extractMessagesFromSessionEntries(relevantEntries) : options.messages,
	);

	if (!hasMeaningfulMessages(relevantMessages)) {
		return { skipped: true, appendedMemoryEntries: 0, appendedHistoryBlock: false };
	}

	const response = await buildInlineConsolidationResponse(options, relevantMessages);
	const timestamp = new Date().toISOString();

	if (response.memoryEntries.length > 0) {
		await appendChannelMemoryUpdate(options.channelDir, {
			timestamp,
			entries: response.memoryEntries,
		});
	}

	if (response.historyBlock.trim()) {
		await appendChannelHistoryBlock(options.channelDir, {
			timestamp,
			content: response.historyBlock,
		});
	}

	return {
		skipped: false,
		appendedMemoryEntries: response.memoryEntries.length,
		appendedHistoryBlock: response.historyBlock.trim().length > 0,
	};
}

async function cleanupChannelMemory(options: ConsolidationRunOptions, currentMemory: string): Promise<boolean> {
	if (
		currentMemory.length < MEMORY_CLEANUP_LENGTH_THRESHOLD &&
		countMatchingSectionHeadings(currentMemory, "Update ") < MEMORY_UPDATE_BLOCK_THRESHOLD
	) {
		return false;
	}

	const prompt = `Current MEMORY.md:
${currentMemory}`;
	const nextMemory = await runWorkerPrompt(
		"memory-cleanup",
		options.model,
		options.resolveApiKey,
		MEMORY_CLEANUP_SYSTEM_PROMPT,
		prompt,
		MEMORY_CLEANUP_TIMEOUT_MS,
	);
	await rewriteChannelMemory(options.channelDir, nextMemory);
	return true;
}

async function foldChannelHistory(options: ConsolidationRunOptions, currentHistory: string): Promise<boolean> {
	const sections = splitMarkdownSections(currentHistory);
	if (currentHistory.length < HISTORY_LENGTH_THRESHOLD && sections.length < HISTORY_BLOCK_THRESHOLD) {
		return false;
	}

	if (sections.length <= HISTORY_RECENT_BLOCKS_TO_KEEP) {
		return false;
	}

	const olderSections = sections.slice(0, -HISTORY_RECENT_BLOCKS_TO_KEEP);
	const recentSections = sections.slice(-HISTORY_RECENT_BLOCKS_TO_KEEP);
	const prompt = `Older history blocks to fold:
${olderSections.map((section) => `## ${section.heading}\n\n${section.content}`).join("\n\n")}`;
	const foldedSummary = await runWorkerPrompt(
		"history-folding",
		options.model,
		options.resolveApiKey,
		HISTORY_FOLDING_SYSTEM_PROMPT,
		prompt,
		HISTORY_FOLDING_TIMEOUT_MS,
	);

	const foldedHeading = `## Folded History Through ${olderSections[olderSections.length - 1]?.heading ?? new Date().toISOString()}`;
	const rebuiltHistory = [
		"# Channel History",
		"",
		foldedHeading,
		"",
		normalizeText(foldedSummary),
		"",
		...recentSections.flatMap((section) => [`## ${section.heading}`, "", normalizeText(section.content), ""]),
	].join("\n");

	await rewriteChannelHistory(options.channelDir, rebuiltHistory);
	return true;
}

export async function runBackgroundMaintenance(options: ConsolidationRunOptions): Promise<BackgroundMaintenanceResult> {
	const currentMemory = await readChannelMemory(options.channelDir);
	const currentHistory = await readChannelHistory(options.channelDir);

	const cleanedMemory = await cleanupChannelMemory(options, currentMemory);
	const foldedHistory = await foldChannelHistory(options, currentHistory);

	return { cleanedMemory, foldedHistory };
}
