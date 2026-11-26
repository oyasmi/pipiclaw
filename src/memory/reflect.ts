import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ModelRequests } from "../models/requests.js";
import { parseJsonObject } from "../shared/llm-json.js";
import { localDayKey } from "../shared/local-time.js";
import { readOptionalTextFile } from "../shared/os.js";
import { clipText } from "../shared/text-utils.js";
import { extractAnchors, findUnanchored, toolResultProvenance } from "./anchors.js";
import { buildMemoryIndexForBootstrap, MEMORY_INDEX_MAX_UNITS } from "./index-budget.js";
import { appendJournalEntries } from "./journal.js";
import { MEMORY_INPUT_SAFETY_RULES } from "./prompt-safety.js";
import { runRetriedSidecarTask } from "./sidecar-worker.js";
import { MEMORY_TRANSCRIPT_MAX_CHARS } from "./source-window.js";
import {
	applyMemoryOps,
	expireProbationaryEntries,
	isValidMemoryName,
	listMemoryEntries,
	type MemoryEntry,
	type MemoryStoreOp,
	type MemoryType,
	memoryActivityDate,
	renderMemoryIndex,
} from "./store.js";
import { hasMeaningfulExchange, messageText, sanitizeMessagesForMemory } from "./transcript.js";

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
const WORKSPACE_MEMORY_MAX_CHARS = 3_000;
const JOURNAL_TAIL_MAX_CHARS = 3_000;
const REFLECT_BODIES_MAX_CHARS = 6_000;

function probationDeadline(today: string): string {
	const ms = new Date(`${today}T00:00:00`).getTime() + PROBATION_DAYS * 24 * 60 * 60 * 1000;
	return localDayKey(new Date(ms));
}

const REFLECT_SYSTEM_PROMPT = `You are Pipiclaw's memory reflection worker. You run in the background, after a chunk of
conversation, to keep this desk's durable memory and daily journal accurate. A desk's memory is shared by every
channel bound to it, and different people may talk to it.

Return strict JSON only. Do not wrap in Markdown fences.

Output schema:
{
  "journal": ["HH:MM one terse bullet about what happened, was decided, or is blocked"],
  "ops": [
    {"op": "add", "name": "kebab-case-handle (optional)", "type": "user|feedback|project|reference", "description": "one self-contained line", "details": "optional long form", "durability": "stable|state", "confidence": 0.0, "necessity": "low|medium|high", "reason": "why"},
    {"op": "update", "name": "existing-name", "description": "...", "details": "(omit to keep existing body)", "durability": "stable|state", "confidence": 0.0, "necessity": "low|medium|high", "reason": "why"},
    {"op": "delete", "name": "existing-name", "confidence": 0.0, "reason": "why this is no longer true"},
    {"op": "touch", "names": ["existing-name", "..."]}
  ],
  "discarded": [{"content": "...", "reason": "..."}]
}

Rules:
${MEMORY_INPUT_SAFETY_RULES}
- journal: record what happened, what was decided, what is blocked, what's next — terse, one bullet per item. Skip small talk, tool-output echoes, and anything already recorded today (you can see today's journal below).
- memory (the "ops" array) is for facts that matter to EVERY future session, not this one's progress:
  - "user": who a person is — name/handle, language, role expectations, long-term preferences. Say whose it is (their name or handle): never write one person's preference as if it held for everyone this desk talks to.
  - "feedback": corrections about how to work, and lessons learned from a mistake.
  - "project": stable facts, decisions, and constraints about what you're working on.
  - "reference": pointers — paths, URLs, commands, contacts, ids.
- Every add/update MUST classify "durability":
  - "stable": remains true until someone explicitly changes the preference, decision, convention, or pointer.
  - "state": describes current code, system, or work status expected to change after later work (e.g., "X currently has a P1 regression", "current version is not ready to release", "task Y was restored", "a review found two P2 bugs"). NEVER put "state" facts in "ops" — record them in "journal" instead.
- An explicit standing rule from the user is a high-necessity, stable project constraint when future work must follow it. Extract it even if it was mentioned alongside a one-off request, tool output, or unrelated chat.
- Never write in-progress task state, transient debugging notes, point-in-time review findings, or anything with a natural end date as memory — that belongs in "journal", or the user should be told to use a task if it needs tracking. If the whole window is just progress or point-in-time status, "ops" should be empty (except "delete" if it resolves a stale entry or "touch" if it confirms an existing one).
- Prefer "update" over adding a near-duplicate of an existing entry (the index is given to you in full below); on "update", omit "details" unless you intend to replace the entry's existing body. Prefer "delete" over leaving a fact that the window shows is fixed or no longer true.
- "touch" lists the names of existing entries this window depended on or confirmed — do this whenever relevant, it costs nothing and promotes probationary entries while keeping active permanent entries fresh.
- Every add/update needs a calibrated confidence (0.0-1.0) and necessity ("high": would future turns go wrong or redo work without this; "medium": useful operating knowledge, nothing breaks without it; "low": not worth writing). Every delete needs a calibrated confidence.
- name must be lowercase kebab-case (letters, digits, hyphens only) if given at all; omit it to let the runtime generate one.
- Empty arrays are correct when nothing applies. Put anything you considered and rejected in "discarded".`;

const CONDENSE_INSTRUCTIONS = `
This desk's memory index no longer fits its budget. In addition to the rules above, this run
should also condense: merge entries that say overlapping things into one better entry (delete the
old ones, add or update the merged one), and delete anything stale. The delete cap is relaxed for
this run — use it. Every delete should either be covered by an add/update that keeps its real
content, or its reason should say plainly why the fact no longer matters.`;

export interface ReflectRunOptions {
	channelId?: string;
	deskDir: string;
	workspaceDir: string;
	model: Model<Api>;
	modelRequests: ModelRequests;
	resolveFallbackModel?: () => Promise<Model<Api> | null>;
	/** The conversation window to reflect on (already extracted by the caller's source window). */
	messages: AgentMessage[];
	/**
	 * Optional pre-formatted non-chat source (e.g. a closed task's distilled archive).
	 * When set, `messages` is ignored and this block is reflected on directly.
	 */
	sourceText?: { label: string; text: string; hasUserMessage?: boolean };
	timeoutMs?: number;
	/** Closed boundary snapshots cannot wait for an answer from the outgoing session. */
	sourceClosed?: boolean;
	usageContext?: { channelId: string; desk?: string; correlationId?: string };
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
	/** Accepted destructive operations, for the review log. */
	decisions?: ReflectOpOutcome[];
}

const REFLECT_DEFAULT_TIMEOUT_MS = 45_000;

interface RawOp {
	op?: unknown;
	name?: unknown;
	names?: unknown;
	type?: unknown;
	description?: unknown;
	details?: unknown;
	durability?: unknown;
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

function normalizeDurability(value: unknown): "stable" | "state" | undefined {
	return value === "stable" || value === "state" ? value : undefined;
}

/**
 * Durable if high-necessity, confident, and explicitly `stable`; probationary for medium-necessity
 * `add` or when `durability` was omitted on a high-necessity `add` (safety net so unlabelled
 * point-in-time facts expire after 30 days instead of polluting permanently).
 */
function classifyWrite(
	op: "add" | "update",
	confidence: number,
	necessity: "low" | "medium" | "high",
	durability: "stable" | "state" | undefined,
): "durable" | "probationary" | undefined {
	if (durability === "state") return undefined;
	if (necessity === "high" && confidence >= DURABLE_CONFIDENCE) {
		if (op === "add" && durability === undefined) return "probationary";
		return "durable";
	}
	if (op === "add" && necessity === "medium" && confidence >= PROBATION_CONFIDENCE) return "probationary";
	return undefined;
}

function renderIndexBodiesForReflect(entries: MemoryEntry[]): string {
	const withBody = entries
		.filter((entry) => entry.body.trim().length > 0)
		.sort((a, b) => memoryActivityDate(b).localeCompare(memoryActivityDate(a)) || a.name.localeCompare(b.name));
	if (withBody.length === 0) return "";
	const blocks: string[] = [];
	const omitted: string[] = [];
	let usedChars = 0;
	for (const entry of withBody) {
		const block = `### ${entry.name}\n${entry.body.trim()}`;
		if (usedChars + block.length > REFLECT_BODIES_MAX_CHARS) {
			omitted.push(entry.name);
			continue;
		}
		blocks.push(block);
		usedChars += block.length + 2;
	}
	const parts: string[] = [];
	if (blocks.length > 0) {
		parts.push(`Details of (+) entries:\n${blocks.join("\n\n")}`);
	}
	if (omitted.length > 0) {
		parts.push(`(+ body omitted — leave details unset on update to preserve them): ${omitted.join(", ")}`);
	}
	return parts.join("\n");
}

async function buildPrompt(
	options: ReflectRunOptions,
	today: string,
	source: string,
): Promise<{ prompt: string; condense: boolean; provenance: string }> {
	const [entries, workspaceMemory, journalToday] = await Promise.all([
		listMemoryEntries(options.deskDir),
		readOptionalTextFile(`${options.workspaceDir}/MEMORY.md`),
		readOptionalTextFile(`${options.deskDir}/journal/${today}.md`),
	]);
	const tiered = buildMemoryIndexForBootstrap(entries, MEMORY_INDEX_MAX_UNITS);
	const sourceLabel = options.sourceText?.label ?? "Conversation window to reflect on";
	const transcript = clipText(source, MEMORY_TRANSCRIPT_MAX_CHARS, { headRatio: 0.35 });
	const provenance = [
		source,
		...toolResultProvenance(options.messages),
		...entries.map((entry) => `${entry.description}\n${entry.body}`),
		workspaceMemory,
		journalToday,
	].join("\n\n");

	const bodies = renderIndexBodiesForReflect(entries);
	const sections = [
		`Desk memory index (full):\n${renderMemoryIndex(entries) || "(empty)"}`,
		...(bodies ? [bodies] : []),
		`Workspace background (read-only; do not target it with ops):\n${clipText(workspaceMemory, WORKSPACE_MEMORY_MAX_CHARS, { headRatio: 0.35 }) || "(empty)"}`,
		`Today's journal so far:\n${clipText(journalToday, JOURNAL_TAIL_MAX_CHARS, { headRatio: 0 }) || "(empty)"}`,
		`${sourceLabel}:\n${transcript || "(empty)"}`,
	];
	if (tiered.overBudget) {
		sections.push(CONDENSE_INSTRUCTIONS.trim());
	}
	return { prompt: sections.join("\n\n"), condense: tiered.overBudget, provenance };
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
	const expiredProbation = await expireProbationaryEntries(options.deskDir, today);

	const sanitized = options.sourceText ? [] : sanitizeMessagesForMemory(options.messages);
	if (options.sourceText) {
		if (!options.sourceText.text.trim()) {
			return { ...empty, skipped: true, expiredProbation };
		}
	} else if (
		!hasMeaningfulExchange(sanitized) &&
		!(options.sourceClosed && sanitized.some((message) => message.role === "user" && messageText(message).trim()))
	) {
		return { ...empty, skipped: true, expiredProbation };
	}

	const source = options.sourceText?.text ?? serializeConversation(sanitized);
	const { prompt, condense, provenance } = await buildPrompt(options, today, source);
	const response = await runRetriedSidecarTask({
		name: "memory-reflect",
		model: options.model,
		modelRequests: options.modelRequests,
		resolveFallbackModel: options.resolveFallbackModel,
		systemPrompt: REFLECT_SYSTEM_PROMPT,
		prompt,
		timeoutMs: options.timeoutMs ?? REFLECT_DEFAULT_TIMEOUT_MS,
		usageContext: options.usageContext ?? (options.channelId ? { channelId: options.channelId } : undefined),
		parse: (text) => parseReflectResponse(parseJsonObject(text)),
	});
	const parsed = response.output;

	const currentEntries = await listMemoryEntries(options.deskDir);
	const byName = new Map(currentEntries.map((entry) => [entry.name, entry]));
	const hasUserMessage = options.sourceText
		? Boolean(options.sourceText.hasUserMessage)
		: sanitized.some((message) => message.role === "user");

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
			const durability = normalizeDurability(raw.durability);
			const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
			// Blank `details` from reflect must never wipe an existing `(+)` body (A3).
			const rawDetails = typeof raw.details === "string" ? raw.details.trim() : "";
			const details = rawDetails ? rawDetails : undefined;
			const type = normalizeType(raw.type);

			// D7 risk table: an `update` naming an entry that doesn't exist downgrades to `add`
			// rather than being silently dropped — the model's judgment about the fact still counts.
			const existing = op === "update" && rawName ? byName.get(rawName) : undefined;
			const effectiveOp: "add" | "update" = existing ? "update" : "add";

			if (durability === "state") {
				rejected.push({
					op: effectiveOp,
					name: existing?.name ?? rawName,
					reason: "state belongs in journal",
				});
				continue;
			}

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

			const tier = classifyWrite(effectiveOp, confidence, necessity, durability);
			if (!tier) {
				rejected.push({
					op: effectiveOp,
					name: existing?.name ?? rawName,
					reason: `confidence ${confidence} / necessity ${necessity} below the write bar`,
				});
				continue;
			}
			const [unanchored] = findUnanchored(extractAnchors(`${description}\n${details ?? ""}`), provenance);
			if (unanchored) {
				rejected.push({
					op: effectiveOp,
					name: existing?.name ?? rawName,
					reason: `unanchored identifier: ${unanchored.slice(0, 80)}`,
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

	// Apply replacements before deleting originals. Any rejected content write makes the
	// entire automatic deletion phase unsafe; delaying unrelated cleanup is intentional.
	const writes = storeOps.filter((op) => op.op !== "delete");
	const deletes = storeOps.filter((op) => op.op === "delete");

	const applied = await applyMemoryOps(options.deskDir, writes, { today });
	// A reused add can be the original itself. Protect actual identities, not requested slugs.
	// Conflicting later writes also cannot serve as evidence for the earlier replacement.
	const live = new Map((await listMemoryEntries(options.deskDir)).map((entry) => [entry.name, entry]));
	const retainedNames = new Set(applied.retained.map((entry) => entry.name));
	const lostReplacement = applied.retained.some((entry) => {
		const current = live.get(entry.name);
		return (
			!current ||
			current.description !== entry.description ||
			current.type !== entry.type ||
			current.body !== entry.body
		);
	});
	const unsafe =
		rejected.some((op) => op.op === "add" || op.op === "update") ||
		applied.skippedSecret > 0 ||
		applied.skippedTombstone > 0 ||
		applied.missingTarget > 0 ||
		lostReplacement;
	if (unsafe) {
		rejected.push(
			...deletes.map((op) => ({
				op: "delete" as const,
				name: op.name,
				reason: "deletion deferred: a replacement failed or targets conflict",
			})),
		);
	} else {
		const safeDeletes = deletes.filter((op) => {
			if (!retainedNames.has(op.name)) return true;
			rejected.push({
				op: "delete",
				name: op.name,
				reason: "deletion deferred: live replacement identity must be retained",
			});
			return false;
		});
		const removed = await applyMemoryOps(options.deskDir, safeDeletes, { today });
		applied.deleted.push(...removed.deleted);
	}
	// Keep the accepted destructive decisions inspectable, not just a list of names.
	const decisions = deletes
		.filter((op) => applied.deleted.includes(op.name))
		.map((op) => ({ op: "delete" as const, name: op.name, reason: op.reason ?? "reflect" }));
	const journalResult = await appendJournalEntries(options.deskDir, today, parsed.journal);

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
		decisions,
	};
}
