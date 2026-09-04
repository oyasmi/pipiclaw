import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import { readOptionalTextFile } from "../shared/fs-utils.js";
import { parseJsonObject } from "../shared/llm-json.js";
import { localDayKey } from "../shared/local-time.js";
import { clipText } from "../shared/text-utils.js";
import { buildChannelIndexForBootstrap, CHANNEL_INDEX_MAX_UNITS } from "./index-budget.js";
import { appendJournalEntries } from "./journal.js";
import { MEMORY_INPUT_SAFETY_RULES } from "./prompt-safety.js";
import { runRetriedSidecarTask } from "./sidecar-worker.js";
import {
	applyMemoryOps,
	expireProbationaryEntries,
	isValidMemoryName,
	listMemoryEntries,
	type MemoryStoreOp,
	type MemoryType,
	renderMemoryIndex,
} from "./store.js";
import { hasMeaningfulExchange, sanitizeMessagesForMemory } from "./transcript.js";

/**
 * Spec 050, D7: the single background pass that replaces session-refresh, memory-checkpoint,
 * and structural-maintenance (cleanup + fold). One LLM call reads a conversation window plus the
 * current index/journal and returns journal entries and memory ops; every invariant in this file
 * is deterministic and independently testable — the model's job is judgment, not bookkeeping.
 */

const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];
const DURABLE_CONFIDENCE = 0.85;
const PROBATION_CONFIDENCE = 0.9;
const PROBATION_DAYS = 30;
const MAX_ADD_PER_RUN = 8;
const MAX_PROBATIONARY_ADD_PER_RUN = 5;
const MAX_DELETE_PER_RUN = 3;
const MAX_DELETE_PER_RUN_CONDENSE = 8;
const TRANSCRIPT_MAX_CHARS = 28_000;
const WORKSPACE_MEMORY_MAX_CHARS = 3_000;
const JOURNAL_TAIL_MAX_CHARS = 3_000;

function probationDeadline(today: string): string {
	const ms = new Date(`${today}T00:00:00`).getTime() + PROBATION_DAYS * 24 * 60 * 60 * 1000;
	return localDayKey(new Date(ms));
}

const REFLECT_SYSTEM_PROMPT = `You are Pipiclaw's memory reflection worker. You run in the background, after a chunk of
conversation, to keep this channel's durable memory and daily journal accurate.

Return strict JSON only. Do not wrap in Markdown fences.

Output schema:
{
  "journal": ["HH:MM one terse bullet about what happened, was decided, or is blocked"],
  "ops": [
    {"op": "add", "name": "kebab-case-handle (optional)", "type": "user|feedback|project|reference", "description": "one self-contained line", "details": "optional long form", "confidence": 0.0, "necessity": "low|medium|high", "reason": "why"},
    {"op": "update", "name": "existing-name", "description": "...", "details": "...", "confidence": 0.0, "necessity": "low|medium|high", "reason": "why"},
    {"op": "delete", "name": "existing-name", "confidence": 0.0, "reason": "why this is no longer true"},
    {"op": "touch", "names": ["existing-name", "..."]}
  ],
  "discarded": [{"content": "...", "reason": "..."}]
}

Rules:
${MEMORY_INPUT_SAFETY_RULES}
- journal: record what happened, what was decided, what is blocked, what's next — terse, one bullet per item. Skip small talk, tool-output echoes, and anything already recorded today (you can see today's journal below).
- memory (the "ops" array) is for facts that matter to EVERY future session, not this one's progress:
  - "user": who the user is — name/handle, language, role expectations, long-term preferences.
  - "feedback": corrections about how to work, and lessons learned from a mistake.
  - "project": stable facts, decisions, and constraints about what you're working on.
  - "reference": pointers — paths, URLs, commands, contacts, ids.
- Never write in-progress task state, transient debugging notes, or anything with a natural end date as memory — that belongs in "journal", or the user should be told to use a task if it needs tracking. If the whole window is just progress on something, "ops" should be empty.
- Prefer "update" over adding a near-duplicate of an existing entry (the index is given to you in full below); prefer "delete" over leaving a fact that the conversation shows is no longer true.
- "touch" lists the names of existing entries this window's conversation depended on or confirmed — do this whenever relevant, it costs nothing and is how a probationary entry becomes permanent.
- Every add/update needs a calibrated confidence (0.0-1.0) and necessity ("high": would future turns go wrong or redo work without this; "medium": useful operating knowledge, nothing breaks without it; "low": not worth writing). Every delete needs a calibrated confidence.
- name must be lowercase kebab-case (letters, digits, hyphens only) if given at all; omit it to let the runtime generate one.
- Empty arrays are correct when nothing applies. Put anything you considered and rejected in "discarded".`;

const CONDENSE_INSTRUCTIONS = `
This channel's memory index no longer fits its budget. In addition to the rules above, this run
should also condense: merge entries that say overlapping things into one better entry (delete the
old ones, add or update the merged one), and delete anything stale. The delete cap is relaxed for
this run — use it. Every delete should either be covered by an add/update that keeps its real
content, or its reason should say plainly why the fact no longer matters.`;

export interface ReflectRunOptions {
	channelId?: string;
	channelDir: string;
	workspaceDir: string;
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	/** The conversation window to reflect on (already extracted by the caller's source window). */
	messages: AgentMessage[];
	timeoutMs?: number;
	usageContext?: { channelId: string; correlationId?: string };
	/** Injectable for tests; defaults to today. */
	today?: string;
}

export interface ReflectOpOutcome {
	op: "add" | "update" | "delete" | "touch";
	name?: string;
	names?: string[];
	reason: string;
}

export interface ReflectRunResult {
	/** No meaningful exchange in the window — nothing was called, nothing was written. */
	skipped: boolean;
	condensed: boolean;
	journalAppended: number;
	journalSkippedDuplicate: number;
	added: string[];
	updated: string[];
	deleted: string[];
	touched: string[];
	renamed: Array<{ requested: string; used: string }>;
	expiredProbation: string[];
	/** Ops the model proposed but a deterministic invariant rejected — surfaced for the review log. */
	rejected: ReflectOpOutcome[];
	discarded: Array<{ content: string; reason: string }>;
}

const REFLECT_DEFAULT_TIMEOUT_MS = 45_000;

interface RawOp {
	op?: unknown;
	name?: unknown;
	names?: unknown;
	type?: unknown;
	description?: unknown;
	details?: unknown;
	confidence?: unknown;
	necessity?: unknown;
	reason?: unknown;
}

interface ParsedReflectResponse {
	journal: string[];
	ops: RawOp[];
	discarded: Array<{ content: string; reason: string }>;
}

function parseReflectResponse(value: unknown): ParsedReflectResponse {
	const record = (value ?? {}) as Record<string, unknown>;
	return {
		journal: Array.isArray(record.journal)
			? record.journal.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
			: [],
		ops: Array.isArray(record.ops) ? (record.ops as RawOp[]).filter((op) => op && typeof op === "object") : [],
		discarded: Array.isArray(record.discarded)
			? record.discarded
					.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
					.map((item) => ({
						content: typeof item.content === "string" ? item.content : "",
						reason: typeof item.reason === "string" ? item.reason : "",
					}))
					.filter((item) => item.content.trim() || item.reason.trim())
			: [],
	};
}

function normalizeConfidence(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function normalizeNecessity(value: unknown): "low" | "medium" | "high" {
	return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function normalizeType(value: unknown): MemoryType | undefined {
	return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value)
		? (value as MemoryType)
		: undefined;
}

/** Durable if high-necessity and confident; probationary only for a medium-necessity `add`; else rejected. */
function classifyWrite(
	op: "add" | "update",
	confidence: number,
	necessity: "low" | "medium" | "high",
): "durable" | "probationary" | undefined {
	if (necessity === "high" && confidence >= DURABLE_CONFIDENCE) return "durable";
	if (op === "add" && necessity === "medium" && confidence >= PROBATION_CONFIDENCE) return "probationary";
	return undefined;
}

async function buildPrompt(options: ReflectRunOptions, today: string): Promise<{ prompt: string; condense: boolean }> {
	const [entries, workspaceMemory, journalToday] = await Promise.all([
		listMemoryEntries(options.channelDir),
		readOptionalTextFile(`${options.workspaceDir}/MEMORY.md`),
		readOptionalTextFile(`${options.channelDir}/journal/${today}.md`),
	]);
	const tiered = buildChannelIndexForBootstrap(entries, CHANNEL_INDEX_MAX_UNITS);
	const transcript = clipText(
		serializeConversation(sanitizeMessagesForMemory(options.messages)),
		TRANSCRIPT_MAX_CHARS,
		{ headRatio: 0.35 },
	);

	const sections = [
		`Channel memory index (full):\n${renderMemoryIndex(entries) || "(empty)"}`,
		`Workspace background (read-only; do not target it with ops):\n${clipText(workspaceMemory, WORKSPACE_MEMORY_MAX_CHARS, { headRatio: 0.35 }) || "(empty)"}`,
		`Today's journal so far:\n${clipText(journalToday, JOURNAL_TAIL_MAX_CHARS, { headRatio: 0 }) || "(empty)"}`,
		`Conversation window to reflect on:\n${transcript || "(empty)"}`,
	];
	if (tiered.overBudget) {
		sections.push(CONDENSE_INSTRUCTIONS.trim());
	}
	return { prompt: sections.join("\n\n"), condense: tiered.overBudget };
}

/**
 * Run one reflect pass over `options.messages`. Deterministic invariants (write tier, per-run
 * caps, `source: user` protection, name resolution) are applied here before anything reaches
 * `store.applyMemoryOps`, which owns only the mechanics (tombstones, secrets, atomic writes).
 */
export async function runReflect(options: ReflectRunOptions): Promise<ReflectRunResult> {
	const today = options.today ?? localDayKey();
	const empty: ReflectRunResult = {
		skipped: true,
		condensed: false,
		journalAppended: 0,
		journalSkippedDuplicate: 0,
		added: [],
		updated: [],
		deleted: [],
		touched: [],
		renamed: [],
		expiredProbation: [],
		rejected: [],
		discarded: [],
	};

	// Deterministic pre-step, independent of whether the window has meaningful material.
	const expiredProbation = await expireProbationaryEntries(options.channelDir, today);

	const sanitized = sanitizeMessagesForMemory(options.messages);
	if (!hasMeaningfulExchange(sanitized)) {
		return { ...empty, skipped: true, expiredProbation };
	}

	const { prompt, condense } = await buildPrompt(options, today);
	const response = await runRetriedSidecarTask({
		name: "memory-reflect",
		model: options.model,
		resolveApiKey: options.resolveApiKey,
		systemPrompt: REFLECT_SYSTEM_PROMPT,
		prompt,
		timeoutMs: options.timeoutMs ?? REFLECT_DEFAULT_TIMEOUT_MS,
		usageContext: options.usageContext ?? (options.channelId ? { channelId: options.channelId } : undefined),
		parse: (text) => parseReflectResponse(parseJsonObject(text)),
	});
	const parsed = response.output;

	const currentEntries = await listMemoryEntries(options.channelDir);
	const byName = new Map(currentEntries.map((entry) => [entry.name, entry]));
	const hasUserMessage = sanitized.some((message) => message.role === "user");

	const rejected: ReflectOpOutcome[] = [];
	const storeOps: MemoryStoreOp[] = [];
	let addCount = 0;
	let probationaryAddCount = 0;
	let deleteCount = 0;
	const deleteCap = condense ? MAX_DELETE_PER_RUN_CONDENSE : MAX_DELETE_PER_RUN;
	const touchNames: string[] = [];

	for (const raw of parsed.ops) {
		const op = typeof raw.op === "string" ? raw.op : "";
		const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";

		if (op === "touch") {
			const names = Array.isArray(raw.names)
				? raw.names.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
				: [];
			touchNames.push(...names);
			continue;
		}

		if (op === "delete") {
			const name = typeof raw.name === "string" ? raw.name.trim() : "";
			const confidence = normalizeConfidence(raw.confidence);
			const target = name ? byName.get(name) : undefined;
			if (!target) {
				rejected.push({ op: "delete", name, reason: "no such entry" });
				continue;
			}
			if (target.source === "user") {
				rejected.push({ op: "delete", name, reason: "user-saved entries cannot be auto-deleted" });
				continue;
			}
			if (confidence < DURABLE_CONFIDENCE) {
				rejected.push({ op: "delete", name, reason: `confidence ${confidence} below ${DURABLE_CONFIDENCE}` });
				continue;
			}
			if (deleteCount >= deleteCap) {
				rejected.push({ op: "delete", name, reason: "per-run delete cap reached" });
				continue;
			}
			deleteCount++;
			storeOps.push({ op: "delete", name, reason: reason || "reflect" });
			continue;
		}

		if (op === "add" || op === "update") {
			const description = typeof raw.description === "string" ? raw.description.trim() : "";
			if (!description) {
				rejected.push({
					op,
					name: typeof raw.name === "string" ? raw.name : undefined,
					reason: "empty description",
				});
				continue;
			}
			const confidence = normalizeConfidence(raw.confidence);
			const necessity = normalizeNecessity(raw.necessity);
			const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
			const details = typeof raw.details === "string" ? raw.details : undefined;
			const type = normalizeType(raw.type);

			// D7 risk table: an `update` naming an entry that doesn't exist downgrades to `add`
			// rather than being silently dropped — the model's judgment about the fact still counts.
			const existing = op === "update" && rawName ? byName.get(rawName) : undefined;
			const effectiveOp: "add" | "update" = existing ? "update" : "add";

			if (effectiveOp === "update" && existing?.source === "user" && confidence < 0.95) {
				rejected.push({ op: "update", name: existing.name, reason: "user-saved entry needs confidence >= 0.95" });
				continue;
			}
			if (effectiveOp === "update" && existing?.source === "user" && !hasUserMessage) {
				rejected.push({
					op: "update",
					name: existing.name,
					reason: "user-saved entry can only be updated in a window that includes a user message",
				});
				continue;
			}

			const tier = classifyWrite(effectiveOp, confidence, necessity);
			if (!tier) {
				rejected.push({
					op: effectiveOp,
					name: existing?.name ?? rawName,
					reason: `confidence ${confidence} / necessity ${necessity} below the write bar`,
				});
				continue;
			}
			if (effectiveOp === "add") {
				if (addCount >= MAX_ADD_PER_RUN) {
					rejected.push({ op: "add", name: rawName, reason: "per-run add cap reached" });
					continue;
				}
				if (tier === "probationary" && probationaryAddCount >= MAX_PROBATIONARY_ADD_PER_RUN) {
					rejected.push({ op: "add", name: rawName, reason: "per-run probationary-add cap reached" });
					continue;
				}
				addCount++;
				if (tier === "probationary") probationaryAddCount++;
				storeOps.push({
					op: "add",
					description,
					details,
					source: "agent",
					type,
					name: rawName && isValidMemoryName(rawName) ? rawName : undefined,
					expires: tier === "probationary" ? probationDeadline(today) : null,
				});
			} else if (existing) {
				storeOps.push({
					op: "update",
					name: existing.name,
					description,
					details,
					type,
					expires: tier === "probationary" ? probationDeadline(today) : null,
				});
			}
			continue;
		}

		rejected.push({ op: "add", reason: `unknown op ${JSON.stringify(raw.op)}` });
	}

	if (touchNames.length > 0) {
		storeOps.push({ op: "touch", names: touchNames });
	}

	const applied = await applyMemoryOps(options.channelDir, storeOps, { today });
	const journalResult = await appendJournalEntries(options.channelDir, today, parsed.journal);

	return {
		skipped: false,
		condensed: condense,
		journalAppended: journalResult.appended,
		journalSkippedDuplicate: journalResult.skippedDuplicate,
		added: applied.added,
		updated: applied.updated,
		deleted: applied.deleted,
		touched: applied.touched,
		renamed: applied.renamed,
		expiredProbation,
		rejected: [
			...rejected,
			...(applied.skippedTombstone > 0
				? [{ op: "add" as const, reason: `${applied.skippedTombstone} add(s) blocked by tombstone` }]
				: []),
			...(applied.skippedSecret > 0
				? [{ op: "add" as const, reason: `${applied.skippedSecret} op(s) blocked: looked like a secret` }]
				: []),
		],
		discarded: parsed.discarded,
	};
}
