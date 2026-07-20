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
import type { MemoryEntryKind } from "./metadata.js";
import type { MemoryPromotionCandidate, SkillPromotionCandidate } from "./promotion.js";
import { runRetriedSidecarTask } from "./sidecar-worker.js";
import { sanitizeMessagesForMemory } from "./transcript.js";

/**
 * The single LLM extraction pass behind every durable-memory writer.
 *
 * Boundary consolidation, idle consolidation, and the growth review used to run three
 * separate prompts with three schemas and three quality bars — and because two of them
 * applied no confidence gate at all, the standard for MEMORY.md was set by whichever
 * writer happened to fire. They now share this prompt, this schema, and (via
 * `shouldAutoWriteMemory`) one bar. Callers still own their own side effects: only
 * boundaries write HISTORY.md, only the growth review proposes skills.
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
- Every memoryOp must carry a calibrated confidence (0.0-1.0) and a necessity of "low", "medium", or "high".
- necessity is "high" only when future turns would go wrong without this entry. Routine progress is "low".
- Be conservative. Empty arrays are correct when nothing should be stored. Put anything you considered and rejected in "discarded".`;

const HISTORY_BLOCK_RULES = `- historyBlock: concise Markdown summarizing the conversation chunk for later recovery.
- For any conversation that contains at least one meaningful user request and one meaningful assistant reply, return a non-empty historyBlock with at least one bullet.
- Prefer short bullets and short paragraphs. historyBlock is not gated by confidence, so it is the safe place for context that is real but not durable.`;

const SKILL_RULES = `- Workspace skills are procedural memory: reusable workflows, checklists, playbooks, templates, or scripts.
- Propose skill writes only when the workflow is clearly reusable across future tasks.
- Use action=create only for new self-contained skills with YAML frontmatter and a non-empty body.
- Skill names must be lowercase kebab-case.`;

export interface MemoryExtractionPromptOptions {
	includeHistoryBlock: boolean;
	includeSkills: boolean;
}

export function buildMemoryExtractionSystemPrompt(options: MemoryExtractionPromptOptions): string {
	const schemaFields = [
		`  "memoryOps": [{"op": "add|supersede|invalidate", "targetId": "required for supersede/invalidate", "content": "standalone durable memory bullet without '-'", "kind": "fact|preference|decision|constraint|open-loop|lesson", "confidence": 0.0, "necessity": "low|medium|high", "reason": "why it should or should not be stored"}]`,
	];
	if (options.includeHistoryBlock) {
		schemaFields.push(`  "historyBlock": "string"`);
	}
	if (options.includeSkills) {
		schemaFields.push(
			`  "skillCandidates": [{"action": "create|patch|write_file", "name": "skill-name", "content": "full SKILL.md or supporting file content", "filePath": "optional supporting file path", "find": "exact patch find text", "replace": "exact patch replacement text", "confidence": 0.0, "necessity": "low|medium|high", "reason": "why this procedural memory matters"}]`,
		);
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
		MEMORY_OPS_RULES,
		...(options.includeHistoryBlock ? [HISTORY_BLOCK_RULES] : []),
		...(options.includeSkills ? [SKILL_RULES] : []),
	].join("\n");
}

export interface MemoryExtractionResult {
	memoryOps: MemoryPromotionCandidate[];
	skillCandidates: SkillPromotionCandidate[];
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

function normalizeSkillCandidate(value: unknown): SkillPromotionCandidate | null {
	if (!isRecord(value)) {
		return null;
	}
	const action = value.action;
	if (action !== "create" && action !== "patch" && action !== "write_file") {
		return null;
	}
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (!name) {
		return null;
	}
	return {
		action,
		name,
		content: typeof value.content === "string" ? value.content : undefined,
		filePath: typeof value.filePath === "string" ? value.filePath : undefined,
		find: typeof value.find === "string" ? value.find : undefined,
		replace: typeof value.replace === "string" ? value.replace : undefined,
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
		skillCandidates: Array.isArray(record.skillCandidates)
			? record.skillCandidates
					.map(normalizeSkillCandidate)
					.filter((item): item is SkillPromotionCandidate => item !== null)
			: [],
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

/** Turn an accepted candidate into a write op, stamping shared provenance metadata. */
export function toMemoryOp(
	candidate: MemoryPromotionCandidate,
	provenance: { sourceEntryIds?: string[]; correlationId?: string },
): MemoryOp {
	if (candidate.op === "invalidate") {
		return { op: "invalidate", targetId: candidate.targetId ?? "", reason: candidate.reason };
	}
	const metadata = {
		kind: candidate.kind,
		sourceType: "agent" as const,
		trust: "inferred" as const,
		sourceCorrelationId: provenance.correlationId,
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

/** Entries rendered as `id — content` so supersede/invalidate can reference real ids. */
function renderMemoryEntriesForPrompt(rawMemory: string): string {
	const entries = parseChannelMemoryEntries(rawMemory);
	if (entries.length === 0) {
		return "";
	}
	return entries.map((entry) => `${entry.id} — ${entry.content}`).join("\n");
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
	loadedSkills?: Array<{ name: string; description?: string }>;
	usageContext?: { channelId: string; correlationId?: string };
}

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
	const currentMemory = clipText(renderMemoryEntriesForPrompt(rawMemory), 8_000, { headRatio: 0.35 });

	const promptSections = [
		`Current SESSION.md:\n${clipText(currentSession, 8_000, { headRatio: 0.35 }) || "(empty)"}`,
		`Current MEMORY.md entries (id — content; reference ids in supersede/invalidate):\n${currentMemory || "(empty)"}`,
		`Channel history file:\n${clipText(currentHistory, 8_000, { headRatio: 0.35 }) || "(empty)"}`,
	];
	if (request.includeSkills) {
		const skills = (request.loadedSkills ?? [])
			.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`)
			.join("\n");
		promptSections.push(`Loaded workspace skills:\n${skills || "(none)"}`);
	}
	promptSections.push(`Conversation chunk to persist:\n${transcript || "(empty)"}`);

	const result = await runRetriedSidecarTask({
		name: request.name,
		model: request.model,
		resolveApiKey: request.resolveApiKey,
		systemPrompt: buildMemoryExtractionSystemPrompt({
			includeHistoryBlock: request.includeHistoryBlock,
			includeSkills: request.includeSkills,
		}),
		prompt: promptSections.join("\n\n"),
		timeoutMs: request.timeoutMs,
		usageContext: request.usageContext,
		parse: (text) => parseMemoryExtractionResult(parseJsonObject(text)),
	});
	return result.output;
}
