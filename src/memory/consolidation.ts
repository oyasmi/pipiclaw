import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import {
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionMessageEntry,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import type { PipiclawMemoryMaintenanceSettings } from "../settings.js";
import { parseJsonObject } from "../shared/llm-json.js";
import { splitH2Sections } from "../shared/markdown-sections.js";
import { clipText } from "../shared/text-utils.js";
import {
	appendChannelHistoryArchive,
	appendChannelHistoryBlock,
	applyChannelMemoryOps,
	type MemoryOp,
	parseChannelMemoryEntries,
	readChannelHistory,
	readChannelMemory,
	readChannelSession,
	rewriteChannelHistory,
	rewriteChannelMemory,
} from "./files.js";
import { runRetriedSidecarTask, runSidecarTask } from "./sidecar-worker.js";
import type { MemorySourceWindow } from "./source-window.js";
import { sanitizeMessagesForMemory } from "./transcript.js";

const INLINE_TRANSCRIPT_MAX_CHARS = 28_000;
const MEMORY_CLEANUP_LENGTH_THRESHOLD = 5_000;
const MEMORY_UPDATE_BLOCK_THRESHOLD = 4;
const HISTORY_LENGTH_THRESHOLD = 8_000;
const HISTORY_BLOCK_THRESHOLD = 5;
const HISTORY_RECENT_BLOCKS_TO_KEEP = 3;
const INLINE_CONSOLIDATION_TIMEOUT_MS = 20_000;
const MEMORY_CLEANUP_TIMEOUT_MS = 120_000;
const HISTORY_FOLDING_TIMEOUT_MS = 120_000;

export type ConsolidationMode = "idle" | "boundary";

const MEMORY_OPS_RULES = `- memoryOps entries operate on the durable channel MEMORY.md:
  - {"op":"add","content":"..."} for a genuinely new durable fact.
  - {"op":"supersede","targetId":"m-xxxx","content":"..."} when new information updates or contradicts an existing entry (use its id).
  - {"op":"invalidate","targetId":"m-xxxx","reason":"..."} when an existing entry is now obsolete or resolved.
- Only reference targetId values that appear in the current MEMORY.md entries shown below.
- Durable = stable facts, decisions, preferences, constraints, or medium-horizon open loops.
- Each content string must be a standalone, keyword-rich sentence fragment suitable for a Markdown bullet (no leading "-"). Write it so future keyword search can find it.
- Do not add content already present in SESSION.md or MEMORY.md; prefer supersede/invalidate over piling on near-duplicates.
- Do not promote active execution state, temporary debugging observations, completed worklog, raw transcript quotes, acknowledgements, or formatting instructions.`;

const BOUNDARY_INLINE_CONSOLIDATION_SYSTEM_PROMPT = `You are a runtime memory consolidation worker for Pipiclaw.

Return strict JSON only. Do not wrap in Markdown fences.

Output schema:
{
  "memoryOps": [{"op": "add|supersede|invalidate", "targetId": "m-xxxx", "content": "string", "reason": "string"}],
  "historyBlock": "string"
}

Rules:
${MEMORY_OPS_RULES}
- historyBlock: concise Markdown summarizing the conversation chunk for later recovery.
- For any conversation that contains at least one meaningful user request and one meaningful assistant reply, return a non-empty historyBlock with at least one bullet.
- Prefer short bullets and short paragraphs.
- If there is nothing worth storing, return an empty memoryOps array and empty historyBlock.

Example output for a short useful exchange:
{
  "memoryOps": [{"op": "add", "content": "User prefers dark mode in the dashboard"}],
  "historyBlock": "- User asked how to toggle dashboard theme; confirmed dark mode preference."
}`;

const IDLE_INLINE_CONSOLIDATION_SYSTEM_PROMPT = `You are a runtime memory consolidation worker for Pipiclaw.

Return strict JSON only. Do not wrap in Markdown fences.

Output schema:
{
  "memoryOps": [{"op": "add|supersede|invalidate", "targetId": "m-xxxx", "content": "string", "reason": "string"}]
}

Rules:
- This is an idle maintenance pass after a normal assistant turn.
${MEMORY_OPS_RULES}
- Do not summarize the exchange for HISTORY.md. Idle consolidation never writes HISTORY.md.
- If there is nothing durable enough to store, return an empty memoryOps array.

Example output:
{
  "memoryOps": [{"op": "add", "content": "User prefers dark mode in the dashboard"}]
}`;

const MEMORY_CLEANUP_SYSTEM_PROMPT = `You are rewriting a Pipiclaw channel MEMORY.md file.

Return Markdown only. Do not use code fences.

Goals:
- Keep only durable and useful channel memory.
- Remove outdated entries, duplicates, verbose phrasing, transient working state, temporary debugging observations, and completed worklog.
- Organize the result with stable sections where relevant.
- Prefer concise bullets over prose.
- Remove content that is clearly transient session-state and belongs in SESSION.md instead.
- Do not preserve minute-level current task progress unless it is a durable decision, constraint, user preference, or medium-horizon open loop.
- Preserve the top-level "# Channel Memory" heading.
- Every retained bullet must preserve its original <!--id:m-*--> comment exactly.
- Do not invent ids, duplicate ids, prose instructions, or content outside H2 sections.

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
	channelId?: string;
	channelDir: string;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	messages: AgentMessage[];
	sessionEntries?: SessionEntry[];
	sourceWindow?: MemorySourceWindow;
	mode?: ConsolidationMode;
}

function usageContextFor(channelId: string | undefined): { channelId: string } | undefined {
	return channelId ? { channelId } : undefined;
}

export interface InlineConsolidationResult {
	skipped: boolean;
	appendedMemoryEntries: number;
	appendedHistoryBlock: boolean;
}

export interface StructuralMaintenanceStats {
	memoryCleanupNeeded: boolean;
	historyFoldingNeeded: boolean;
	hasMemoryContent: boolean;
	hasHistoryContent: boolean;
}

interface ConsolidationResponse {
	memoryOps: MemoryOp[];
	historyBlock: string;
}

function normalizeText(text: string): string {
	return text.replace(/\r/g, "").trim();
}

function normalizeMemoryOp(value: unknown): MemoryOp | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const content = typeof record.content === "string" ? record.content.trim() : "";
	const targetId = typeof record.targetId === "string" ? record.targetId.trim() : "";
	if (record.op === "supersede" && targetId && content) {
		return { op: "supersede", targetId, content };
	}
	if (record.op === "invalidate" && targetId) {
		return {
			op: "invalidate",
			targetId,
			reason: typeof record.reason === "string" ? record.reason.trim() : undefined,
		};
	}
	// Default to add for "add" or any unrecognized op that still carries content.
	if (content) {
		return { op: "add", content };
	}
	return null;
}

function parseConsolidationResponse(text: string): ConsolidationResponse {
	const parsed = parseJsonObject(text) as { memoryOps?: unknown; historyBlock?: unknown };
	const rawOps = Array.isArray(parsed.memoryOps) ? parsed.memoryOps : [];
	return {
		memoryOps: rawOps.map(normalizeMemoryOp).filter((op): op is MemoryOp => op !== null),
		historyBlock: typeof parsed.historyBlock === "string" ? parsed.historyBlock.trim() : "",
	};
}

function isMessage(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function entriesAfterLatestCompactionBoundary(entries: SessionEntry[]): SessionEntry[] {
	const latestCompaction = getLatestCompactionEntry(entries);
	if (!latestCompaction) return entries;
	const boundaryIndex = entries.findIndex((entry) => entry.id === latestCompaction.firstKeptEntryId);
	return boundaryIndex >= 0 ? entries.slice(boundaryIndex) : entries;
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
	return splitH2Sections(content).filter((section) => section.heading.startsWith(prefix)).length;
}

export function shouldCleanupChannelMemory(currentMemory: string): boolean {
	return (
		currentMemory.length >= MEMORY_CLEANUP_LENGTH_THRESHOLD ||
		countMatchingSectionHeadings(currentMemory, "Update ") >= MEMORY_UPDATE_BLOCK_THRESHOLD
	);
}

export function shouldFoldChannelHistory(currentHistory: string): boolean {
	const sections = splitH2Sections(currentHistory);
	return (
		(currentHistory.length >= HISTORY_LENGTH_THRESHOLD || sections.length >= HISTORY_BLOCK_THRESHOLD) &&
		sections.length > HISTORY_RECENT_BLOCKS_TO_KEEP
	);
}

export function getStructuralMaintenanceStats(
	currentMemory: string,
	currentHistory: string,
): StructuralMaintenanceStats {
	return {
		memoryCleanupNeeded: shouldCleanupChannelMemory(currentMemory),
		historyFoldingNeeded: shouldFoldChannelHistory(currentHistory),
		hasMemoryContent: currentMemory.replace(/^# Channel Memory\s*/i, "").trim().length > 0,
		hasHistoryContent: currentHistory.replace(/^# Channel History\s*/i, "").trim().length > 0,
	};
}

async function runWorkerPrompt(
	name: string,
	model: Model<Api>,
	resolveApiKey: (model: Model<Api>) => Promise<string>,
	systemPrompt: string,
	prompt: string,
	timeoutMs: number,
	usageContext?: { channelId: string },
): Promise<string> {
	const result = await runSidecarTask({
		name,
		model,
		resolveApiKey,
		systemPrompt,
		prompt,
		timeoutMs,
		usageContext,
		parse: (text) => text.trim(),
	});
	return result.output;
}

function renderMemoryEntriesForPrompt(rawMemory: string): string {
	const entries = parseChannelMemoryEntries(rawMemory);
	if (entries.length === 0) {
		return "";
	}
	return entries.map((entry) => `${entry.id} — ${entry.content}`).join("\n");
}

async function buildInlineConsolidationResponse(
	options: ConsolidationRunOptions,
	messages: Message[],
): Promise<ConsolidationResponse> {
	const mode = options.mode ?? "boundary";
	const transcript = clipText(serializeConversation(messages), INLINE_TRANSCRIPT_MAX_CHARS, { headRatio: 0.35 });
	const rawMemory = await readChannelMemory(options.channelDir);
	const currentMemory = clipText(renderMemoryEntriesForPrompt(rawMemory), 8_000, { headRatio: 0.35 });
	const currentSession = clipText(await readChannelSession(options.channelDir), 8_000, { headRatio: 0.35 });
	const currentHistory = clipText(await readChannelHistory(options.channelDir), 8_000, { headRatio: 0.35 });

	const prompt = `Current SESSION.md:
${currentSession || "(empty)"}

Current MEMORY.md entries (id — content; reference ids in supersede/invalidate):
${currentMemory || "(empty)"}

Channel history file:
${currentHistory || "(empty)"}

Conversation chunk to persist:
${transcript || "(empty)"}`;

	const result = await runRetriedSidecarTask({
		name: "memory-inline-consolidation",
		model: options.model,
		resolveApiKey: options.resolveApiKey,
		systemPrompt:
			mode === "idle" ? IDLE_INLINE_CONSOLIDATION_SYSTEM_PROMPT : BOUNDARY_INLINE_CONSOLIDATION_SYSTEM_PROMPT,
		prompt,
		timeoutMs: INLINE_CONSOLIDATION_TIMEOUT_MS,
		usageContext: usageContextFor(options.channelId),
		parse: (text) => text.trim(),
	});
	const rawResponse = result.output;
	return parseConsolidationResponse(rawResponse);
}

export async function runInlineConsolidation(options: ConsolidationRunOptions): Promise<InlineConsolidationResult> {
	const mode = options.mode ?? "boundary";
	const sourceEntries =
		options.sourceWindow?.entries ?? entriesAfterLatestCompactionBoundary(options.sessionEntries ?? []);
	const relevantMessages = sanitizeMessagesForMemory(
		options.sourceWindow?.messages ??
			(sourceEntries.length > 0 ? extractMessagesFromSessionEntries(sourceEntries) : options.messages),
	);

	if (!hasMeaningfulMessages(relevantMessages)) {
		return { skipped: true, appendedMemoryEntries: 0, appendedHistoryBlock: false };
	}

	const response = await buildInlineConsolidationResponse(options, relevantMessages);
	const timestamp = new Date().toISOString();

	let appliedMemoryOps = 0;
	if (response.memoryOps.length > 0 && !options.sourceWindow?.hasExternalToolContent) {
		const sourceEntryIds = options.sourceWindow?.entries.map((entry) => entry.id) ?? [];
		const ops = response.memoryOps.map(
			(op): MemoryOp => (op.op === "add" || op.op === "supersede" ? { ...op, sourceEntryIds } : op),
		);
		const applied = await applyChannelMemoryOps(options.channelDir, ops, timestamp);
		appliedMemoryOps = applied.added + applied.superseded + applied.invalidated + applied.downgradedToAdd;
	}

	if (mode === "boundary" && response.historyBlock.trim()) {
		await appendChannelHistoryBlock(options.channelDir, {
			timestamp,
			content: response.historyBlock,
		});
	}

	return {
		skipped: false,
		appendedMemoryEntries: appliedMemoryOps,
		appendedHistoryBlock: mode === "boundary" && response.historyBlock.trim().length > 0,
	};
}

export type MemoryCleanupShrinkGuard = Pick<
	PipiclawMemoryMaintenanceSettings,
	"cleanupShrinkGuardMinRatio" | "cleanupShrinkGuardMinChars"
>;

export class MemoryCleanupRejectedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "MemoryCleanupRejectedError";
	}
}

// Guard against a cleanup pass that catastrophically drops content (e.g. a truncated
// or malformed LLM response). Backups exist too, but refusing the write avoids
// clobbering good memory in the first place.
function isCleanupResultTooSmall(currentMemory: string, nextMemory: string, guard: MemoryCleanupShrinkGuard): boolean {
	const before = normalizeText(currentMemory);
	const after = normalizeText(nextMemory);
	const beforeEntries = parseChannelMemoryEntries(before).length;
	const afterEntries = parseChannelMemoryEntries(after).length;
	if (beforeEntries > 0 && afterEntries === 0) return true;
	if (before.length < Math.max(0, guard.cleanupShrinkGuardMinChars)) return false;
	if (after.length < before.length * Math.max(0, Math.min(1, guard.cleanupShrinkGuardMinRatio))) {
		return true;
	}
	return beforeEntries > 0 && afterEntries * 2 < beforeEntries;
}

function validateCleanupSchema(currentMemory: string, nextMemory: string): string | null {
	if (!/^# Channel Memory(?:\s|$)/.test(nextMemory.trimStart())) {
		return 'cleanup output must start with "# Channel Memory"';
	}
	const originalIds = new Set(parseChannelMemoryEntries(currentMemory).map((entry) => entry.id));
	const entries = parseChannelMemoryEntries(nextMemory);
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!originalIds.has(entry.id)) return `cleanup output invented unknown entry id ${entry.id}`;
		if (ids.has(entry.id)) return `cleanup output duplicated entry id ${entry.id}`;
		ids.add(entry.id);
	}
	return null;
}

export async function cleanupChannelMemory(
	options: ConsolidationRunOptions,
	currentMemory: string,
	guard?: MemoryCleanupShrinkGuard,
): Promise<boolean> {
	if (!shouldCleanupChannelMemory(currentMemory)) {
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
		usageContextFor(options.channelId),
	);
	const schemaError = validateCleanupSchema(currentMemory, nextMemory);
	if (schemaError) {
		throw new MemoryCleanupRejectedError(
			`${schemaError}. Retry cleanup while preserving the MEMORY.md schema and ids.`,
		);
	}
	if (guard && isCleanupResultTooSmall(currentMemory, nextMemory, guard)) {
		throw new MemoryCleanupRejectedError("cleanup result shrank below the configured guard threshold");
	}
	await rewriteChannelMemory(options.channelDir, nextMemory);
	return true;
}

export async function foldChannelHistory(options: ConsolidationRunOptions, currentHistory: string): Promise<boolean> {
	if (!shouldFoldChannelHistory(currentHistory)) {
		return false;
	}

	const sections = splitH2Sections(currentHistory);
	const olderSections = sections.slice(0, -HISTORY_RECENT_BLOCKS_TO_KEEP);
	const recentSections = sections.slice(-HISTORY_RECENT_BLOCKS_TO_KEEP);
	const renderedOlder = olderSections.map((section) => `## ${section.heading}\n\n${section.content}`).join("\n\n");

	// Preserve the raw blocks before folding turns them lossy, so nothing is
	// permanently blurred by repeated folds.
	await appendChannelHistoryArchive(options.channelDir, {
		timestamp: new Date().toISOString(),
		content: renderedOlder,
	});

	const prompt = `Older history blocks to fold:
${renderedOlder}`;
	const foldedSummary = await runWorkerPrompt(
		"history-folding",
		options.model,
		options.resolveApiKey,
		HISTORY_FOLDING_SYSTEM_PROMPT,
		prompt,
		HISTORY_FOLDING_TIMEOUT_MS,
		usageContextFor(options.channelId),
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
