import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { parseJsonObject } from "../shared/llm-json.js";
import { clipText } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import {
	type MemoryOp,
	parseChannelMemoryEntries,
	readChannelHistory,
	readChannelMemory,
	readChannelSession,
} from "./files.js";
import { type MemoryEntryKind, readMemoryMetadata } from "./metadata.js";
import { probationDeadline } from "./probation.js";
import type { MemoryPromotionCandidate, MemoryWriteTier } from "./promotion.js";
import { MEMORY_INPUT_SAFETY_RULES } from "./prompt-safety.js";
import { tokenizeRecallText } from "./recall.js";
import { runRetriedSidecarTask } from "./sidecar-worker.js";
import { sanitizeMessagesForMemory } from "./transcript.js";

/**
 * The single LLM extraction pass behind every durable-memory writer.
 *
 * Boundary consolidation, idle consolidation, and the growth review used to run three
 * separate prompts with three schemas and three quality bars — and because two of them
 * applied no confidence gate at all, the standard for MEMORY.md was set by whichever
 * writer happened to fire. They now share this prompt, this schema, and (via
 * `classifyMemoryWrite`) the same two-tier bar. Callers still own their own side effects: only
 * boundaries write HISTORY.md.
 */

const MEMORY_OPS_RULES = `- memoryOps entries operate on the durable channel MEMORY.md:
  - {"op":"add","content":"...","kind":"fact|preference|decision|constraint|open-loop|lesson"} for a genuinely new durable fact.
  - {"op":"supersede","targetId":"m-xxxx","content":"...","kind":"..."} when new information updates or contradicts an existing entry (use its id).
  - {"op":"invalidate","targetId":"m-xxxx","reason":"..."} when an existing entry is now obsolete or resolved.
- Only reference targetId values that appear in the current MEMORY.md entries shown below.
- Durable = stable facts, decisions, preferences, constraints, or medium-horizon open loops.
- Each content string must be a standalone, keyword-rich sentence fragment suitable for a Markdown bullet (no leading "-"). Write it so future keyword search can find it.
- Do not add content already present in SESSION.md or MEMORY.md; prefer supersede/invalidate over piling on near-duplicates.
- Do not promote active execution state, temporary debugging observations, completed worklog, raw transcript quotes, acknowledgements, or formatting instructions.
- Every memoryOp must carry a calibrated confidence (0.0-1.0) and a necessity of "low", "medium", or "high":
  - "high": a hard constraint or rule — future turns would go wrong or redo work without this entry.
  - "medium": day-to-day operating knowledge of the team/project that is not a hard constraint — who owns what, what a term or shorthand defaults to, a naming or release convention, who has to sign off on something, a contact for a recurring counterpart. Nothing breaks without it, but knowing it clearly saves rework.
  - "low": one-off progress, transient state, or anything recoverable by re-reading a file.
- Do not pad "high" with material that is only "medium". Do not withhold genuine team/project operating knowledge just because a single missing turn would not break without it — that is exactly what "medium" is for.
- Empty arrays are correct when nothing should be stored; do not force items in. Put anything you considered and rejected in "discarded".`;

const HISTORY_BLOCK_RULES = `- historyBlock: concise Markdown summarizing the conversation chunk for later recovery.
- For any conversation that contains at least one meaningful user request and one meaningful assistant reply, return a non-empty historyBlock with at least one bullet.
- Prefer short bullets and short paragraphs. historyBlock is not gated by confidence, so it is the safe place for context that is real but not durable.`;

export interface MemoryExtractionPromptOptions {
	includeHistoryBlock: boolean;
}

export function buildMemoryExtractionSystemPrompt(options: MemoryExtractionPromptOptions): string {
	const schemaFields = [
		`  "memoryOps": [{"op": "add|supersede|invalidate", "targetId": "required for supersede/invalidate", "content": "standalone durable memory bullet without '-'", "kind": "fact|preference|decision|constraint|open-loop|lesson", "confidence": 0.0, "necessity": "low|medium|high", "reason": "why it should or should not be stored"}]`,
	];
	if (options.includeHistoryBlock) {
		schemaFields.push(`  "historyBlock": "string"`);
	}
	schemaFields.push(`  "discarded": [{"content": "string", "reason": "string"}]`);

	return [
		"You are Pipiclaw's durable memory extraction worker.",
		"",
		"Return strict JSON only. Do not wrap in Markdown fences.",
		"",
		"Output schema:",
		"{",
		schemaFields.join(",\n"),
		"}",
		"",
		"Rules:",
		MEMORY_INPUT_SAFETY_RULES,
		MEMORY_OPS_RULES,
		...(options.includeHistoryBlock ? [HISTORY_BLOCK_RULES] : []),
	].join("\n");
}

export interface MemoryExtractionResult {
	memoryOps: MemoryPromotionCandidate[];
	historyBlock: string;
	discarded: Array<{ content: string; reason: string }>;
}

function normalizeConfidence(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function normalizeNecessity(value: unknown): "low" | "medium" | "high" {
	return value === "high" || value === "medium" || value === "low" ? value : "low";
}

export function normalizeMemoryEntryKind(value: unknown): MemoryEntryKind {
	return value === "preference" ||
		value === "decision" ||
		value === "constraint" ||
		value === "open-loop" ||
		value === "lesson"
		? value
		: "fact";
}

function normalizeMemoryCandidate(value: unknown): MemoryPromotionCandidate | null {
	if (!isRecord(value)) {
		return null;
	}
	// `target` is legacy: channel MEMORY.md is the only durable target. Reject an explicit
	// foreign target, but do not require the field.
	if (value.target !== undefined && value.target !== "channel-memory") {
		return null;
	}
	const op = value.op === "supersede" || value.op === "invalidate" ? value.op : "add";
	const targetId = typeof value.targetId === "string" ? value.targetId.trim() : undefined;
	const content = typeof value.content === "string" ? value.content.trim() : undefined;
	if ((op === "invalidate" && !targetId) || (op !== "invalidate" && !content)) {
		return null;
	}
	return {
		target: "channel-memory",
		op,
		targetId,
		content,
		kind: normalizeMemoryEntryKind(value.kind),
		confidence: normalizeConfidence(value.confidence),
		necessity: normalizeNecessity(value.necessity),
		reason: typeof value.reason === "string" ? value.reason.trim() : "",
	};
}

export function parseMemoryExtractionResult(value: unknown): MemoryExtractionResult {
	const record = isRecord(value) ? value : {};
	// `memoryCandidates` is an older field name still emitted by some models.
	const rawMemoryOps = Array.isArray(record.memoryOps)
		? record.memoryOps
		: Array.isArray(record.memoryCandidates)
			? record.memoryCandidates
			: [];
	return {
		memoryOps: rawMemoryOps
			.map(normalizeMemoryCandidate)
			.filter((item): item is MemoryPromotionCandidate => item !== null),
		historyBlock: typeof record.historyBlock === "string" ? record.historyBlock.trim() : "",
		discarded: Array.isArray(record.discarded)
			? record.discarded
					.filter(isRecord)
					.map((item) => ({
						content: typeof item.content === "string" ? item.content : "",
						reason: typeof item.reason === "string" ? item.reason : "",
					}))
					.filter((item) => item.content.trim() || item.reason.trim())
			: [],
	};
}

/**
 * Turn an accepted candidate into a write op, stamping shared provenance metadata.
 *
 * `tier` stamps `probationUntil` (spec 037, D6/D7): a probationary `add` gets a 30-day deadline
 * that is cancelled the first time the entry is recalled (`recordMemoryRecall`); a durable write
 * stamps `null` to explicitly clear any prior probation — relevant when a durable `supersede`
 * replaces a probationary entry in place (same entry id), which must not silently inherit the
 * old deadline.
 */
export function toMemoryOp(
	candidate: MemoryPromotionCandidate,
	provenance: { sourceEntryIds?: string[]; correlationId?: string },
	tier: MemoryWriteTier,
): MemoryOp {
	if (candidate.op === "invalidate") {
		return { op: "invalidate", targetId: candidate.targetId ?? "", reason: candidate.reason };
	}
	const metadata = {
		kind: candidate.kind,
		sourceType: "agent" as const,
		necessity: candidate.necessity,
		sourceCorrelationId: provenance.correlationId,
		probationUntil: tier === "probationary" ? probationDeadline() : null,
	};
	if (candidate.op === "supersede") {
		return {
			op: "supersede",
			targetId: candidate.targetId ?? "",
			content: candidate.content ?? "",
			sourceEntryIds: provenance.sourceEntryIds,
			metadata,
		};
	}
	return {
		op: "add",
		content: candidate.content ?? "",
		sourceEntryIds: provenance.sourceEntryIds,
		metadata,
	};
}

/**
 * Above this many entries, a full-corpus render stops being useful: MEMORY_ENTRIES clips at 8000
 * chars anyway, so the model never sees enough of the tail to consider superseding it. Past the
 * threshold, render only the entries most lexically similar to this window's transcript, plus
 * every user-saved entry regardless of similarity (a user's explicit fact must always be a
 * candidate for supersede, never silently excluded by relevance ranking).
 */
const MEMORY_ENTRIES_SIMILARITY_THRESHOLD = 40;
const MEMORY_ENTRIES_SIMILARITY_TOP_N = 20;

/**
 * Entries rendered as `id — content` so supersede/invalidate can reference real ids.
 *
 * A lightweight local token-overlap score, not the full recall pipeline — extraction only has a
 * `channelDir`, and reusing `recallRelevantMemory` here would mean threading `workspaceDir`
 * through every consolidation call site just to rank entries already loaded in memory.
 */
async function renderSimilarMemoryEntriesForPrompt(
	channelDir: string,
	rawMemory: string,
	transcript: string,
): Promise<string> {
	const entries = parseChannelMemoryEntries(rawMemory);
	if (entries.length === 0) {
		return "";
	}
	if (entries.length <= MEMORY_ENTRIES_SIMILARITY_THRESHOLD) {
		return entries.map((entry) => `${entry.id} — ${entry.content}`).join("\n");
	}

	const transcriptTokens = new Set(tokenizeRecallText(transcript));
	const scored = entries
		.map((entry) => {
			const entryTokens = tokenizeRecallText(entry.content);
			const overlap = entryTokens.filter((token) => transcriptTokens.has(token)).length;
			return { entry, overlap };
		})
		.sort((a, b) => b.overlap - a.overlap);

	const metadata = await readMemoryMetadata(channelDir);
	const mustKeepIds = new Set(
		entries.filter((entry) => metadata.entries[entry.id]?.sourceType === "user").map((entry) => entry.id),
	);
	const selectedIds = new Set(scored.slice(0, MEMORY_ENTRIES_SIMILARITY_TOP_N).map(({ entry }) => entry.id));
	for (const id of mustKeepIds) selectedIds.add(id);

	const selected = entries.filter((entry) => selectedIds.has(entry.id));
	const note = `[showing ${selected.length} of ${entries.length} entries most relevant to this conversation — not the full file]`;
	return `${note}\n${selected.map((entry) => `${entry.id} — ${entry.content}`).join("\n")}`;
}

export interface MemoryExtractionRequest extends MemoryExtractionPromptOptions {
	name: string;
	channelId?: string;
	channelDir: string;
	messages: AgentMessage[];
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	timeoutMs: number;
	transcriptMaxChars: number;
	usageContext?: { channelId: string; correlationId?: string };
}

/**
 * Tool output never reaches this prompt: `sanitizeMessagesForMemory` drops every `toolResult`
 * message before serialization (`transcript.ts`), an invariant pinned by
 * `test/memory-transcript.test.ts` ("drops tool results ... before memory workers see them").
 * That is why no additional untrusted-content filter is applied here — a window-level one used to
 * exist and silently discarded every durable write from any tool-using conversation.
 */
export async function runMemoryExtraction(request: MemoryExtractionRequest): Promise<MemoryExtractionResult> {
	const [currentSession, rawMemory, currentHistory] = await Promise.all([
		readChannelSession(request.channelDir),
		readChannelMemory(request.channelDir),
		readChannelHistory(request.channelDir),
	]);
	const transcript = clipText(
		serializeConversation(sanitizeMessagesForMemory(request.messages)),
		request.transcriptMaxChars,
		{ headRatio: 0.35 },
	);
	const currentMemory = clipText(
		await renderSimilarMemoryEntriesForPrompt(request.channelDir, rawMemory, transcript),
		8_000,
		{ headRatio: 0.35 },
	);

	const promptSections = [
		`Current SESSION.md:\n${clipText(currentSession, 8_000, { headRatio: 0.35 }) || "(empty)"}`,
		`Current MEMORY.md entries (id — content; reference ids in supersede/invalidate):\n${currentMemory || "(empty)"}`,
		`Channel history file:\n${clipText(currentHistory, 8_000, { headRatio: 0.35 }) || "(empty)"}`,
		`Conversation chunk to persist:\n${transcript || "(empty)"}`,
	];

	const result = await runRetriedSidecarTask({
		name: request.name,
		model: request.model,
		resolveApiKey: request.resolveApiKey,
		systemPrompt: buildMemoryExtractionSystemPrompt({
			includeHistoryBlock: request.includeHistoryBlock,
		}),
		prompt: promptSections.join("\n\n"),
		timeoutMs: request.timeoutMs,
		usageContext: request.usageContext,
		parse: (text) => parseMemoryExtractionResult(parseJsonObject(text)),
	});
	return result.output;
}
