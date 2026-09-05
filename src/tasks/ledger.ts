import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { normalizeSafeId } from "../shared/safe-id.js";
import {
	isTaskRunnable,
	parseTaskFrontmatterV4,
	renderTaskFrontmatter,
	type TaskFrontmatterV4,
} from "./frontmatter.js";

import { ticketDueMs, ticketExpired } from "./ticket.js";

/**
 * Shared reader for the task ledger (`workspace/<channelId>/tasks/*.md`).
 *
 * This is the sole implementation of the frontmatter contract documented in
 * `docs/tasks.md`. The parsing stays deliberately literal (flat `key: value` fields,
 * live-vs-archived, fail-open on unreadable frontmatter) because task files are hand-editable
 * and must degrade toward "wake me up so I can be fixed". `/tasks`, the task digest, and
 * `task_list` all read through here.
 *
 * Spec 051 split the frontmatter contract itself into `frontmatter.ts` (fields) and `ticket.ts`
 * (the waiting claim); what stays here is the *body*: sections, Plan, DoD, and the skeleton.
 */

export interface TaskLedgerEntry {
	/** Filename without `.md`; the task id. */
	id: string;
	/** First `# ` heading in the body, or the id when none. */
	title: string;
	fields: TaskFrontmatterV4;
	/** false => frontmatter could not be read; the task is surfaced rather than skipped. */
	readable: boolean;
	/** True when this file still carries v3 `status`/`control` frontmatter. */
	legacy: boolean;
	/** The driver may schedule a step for this task right now. */
	runnable: boolean;
	/** When a driver-polled ticket (`time`/`schedule`) comes due, if it has not already. */
	dueMs?: number;
	/** True when a parked task's backstop has passed and the runtime owes it a reopen (D2). */
	expired: boolean;
	/** Parsed `## Plan` section, if the task has one (spec 037, D2). */
	plan?: TaskPlanSummary;
}

export interface TaskSkeletonInput {
	title: string;
	goal: string;
	dod: string;
	manual?: string;
	verificationPlan?: string;
	verificationRequired?: boolean;
	/** Optional initial `## Plan` steps, one per line; a missing `P<n>` prefix is auto-assigned. */
	plan?: string;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_TASK_MANUAL =
	"- Follow the DoD, record evidence in every step note, and park on a ticket when waiting.";

export const STANDARD_TASK_SECTIONS = [
	{ label: "Goal", names: ["Goal", "目标"] },
	{ label: "DoD", names: ["DoD"] },
	{ label: "Manual", names: ["Manual", "手册"] },
	{ label: "Verification", names: ["Verification", "验收"] },
] as const;

/**
 * `## Plan` is a deliberately optional section (spec 037, D2) — it is not part of
 * `STANDARD_TASK_SECTIONS`, so `missingStandardTaskSections` never flags its absence. A two-step
 * task or any pre-existing task simply has no Plan.
 */
const PLAN_SECTION_NAMES = ["Plan", "计划"] as const;
/**
 * The single historical paragraph a v4 contract keeps (spec 051, D5). Declared here rather than
 * in `cycle.ts` so `taskContractSegment` can end the contract at it without a circular import.
 */
export const LAST_RESULT_SECTION_NAMES = ["上次结果", "Last Result"] as const;

/** Validate/normalize a task id (filename without `.md`), rejecting path traversal. */
export function normalizeTaskId(id: string): string {
	return normalizeSafeId(id, { suffix: ".md", pattern: TASK_ID_PATTERN, label: "task id" });
}

/** The document body after the leading frontmatter block, or the whole content when there is none. */
export function taskBody(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	const after = content.indexOf("\n", end + 1);
	return after === -1 ? "" : content.slice(after + 1);
}

/**
 * The task's *contract* segment: the body up to (excluding) whichever of "Plan" or "上次结果"
 * appears first — i.e. the H1 title, Goal, DoD (with its checkbox state), Manual and
 * Verification (spec 029, D4).
 *
 * Verification PASS binds to this segment, not the whole body, so routine `progress` notes
 * (Current Cycle, and — spec 037, D1 — Plan step status) never invalidate a PASS; only a change
 * to what the task promises to do and how it is checked does.
 * Plan is deliberately excluded from the contract even though it always precedes Current Cycle
 * in a freshly rendered skeleton: it is the task's *means*, not its promise, and is meant to be
 * revised without re-triggering verification. This also means a task with an existing PASS can
 * have `## Plan` inserted between Verification and Current Cycle with the contract segment
 * unchanged byte-for-byte, as long as nothing before it changed.
 * A body without either heading (non-standard) falls back to the whole body.
 */
export function taskContractSegment(body: string): string {
	const lines = body.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const match = /^#{1,6}\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (
			match &&
			(matchesTaskSectionTitle(match[1] ?? "", PLAN_SECTION_NAMES) ||
				matchesTaskSectionTitle(match[1] ?? "", LAST_RESULT_SECTION_NAMES))
		) {
			return lines.slice(0, index).join("\n").replace(/\s+$/, "");
		}
	}
	return body;
}

/**
 * Hash the task's *contract* segment (Goal/DoD/Manual/Verification), not the whole body, so a
 * verification PASS survives routine step logging and only breaks when the contract itself
 * changes (spec 029, D4). Lives next to `taskContractSegment` because it is that function's
 * only real consumer.
 */
export function taskBodyHash(body: string): string {
	return createHash("sha256").update(taskContractSegment(body)).digest("hex");
}

export type TaskPlanStepStatus = "todo" | "done" | "blocked" | "dropped";

export interface TaskPlanStep {
	/** `P<n>` by convention; a hand-written step without one gets its position as a fallback. */
	id: string;
	status: TaskPlanStepStatus;
	text: string;
	/** DoD item numbers this step claims to cover, from a trailing `→ dod:1,2` (or `-> dod:1,2`). */
	dodRefs: number[];
	lineIndex: number;
}

export interface TaskPlanSummary {
	steps: TaskPlanStep[];
	/** Count of steps, excluding `dropped` ones. */
	total: number;
	done: number;
	/** The first `todo` or `blocked` step in document order; `undefined` once nothing is left to do. */
	current?: TaskPlanStep;
}

const PLAN_STEP_STATUS_BY_MARKER: Record<string, TaskPlanStepStatus> = {
	" ": "todo",
	x: "done",
	X: "done",
	"!": "blocked",
	"~": "dropped",
};
const PLAN_CHECKBOX_LINE = /^\s*[-*]\s+\[([ xX!~])\]\s+(.*)$/;
const PLAN_STEP_ID_PREFIX = /^(P\d+)[.、)]?\s+(\S.*)$/i;
const PLAN_DOD_REF_SUFFIX = /(?:→|->)\s*dod:\s*([\d,\s]+)\s*$/i;

function parsePlanStepLine(line: string, lineIndex: number, fallbackId: string): TaskPlanStep | undefined {
	const checkbox = PLAN_CHECKBOX_LINE.exec(line);
	if (!checkbox) return undefined;
	const status = PLAN_STEP_STATUS_BY_MARKER[checkbox[1] ?? " "] ?? "todo";
	let rest = (checkbox[2] ?? "").trim();

	let dodRefs: number[] = [];
	const dodMatch = PLAN_DOD_REF_SUFFIX.exec(rest);
	if (dodMatch) {
		dodRefs = (dodMatch[1] ?? "")
			.split(",")
			.map((part) => Number.parseInt(part.trim(), 10))
			.filter((n) => Number.isInteger(n) && n > 0);
		rest = rest.slice(0, dodMatch.index).trim();
	}

	const idMatch = PLAN_STEP_ID_PREFIX.exec(rest);
	const id = idMatch ? (idMatch[1] ?? fallbackId).toUpperCase() : fallbackId;
	const text = idMatch ? (idMatch[2] ?? "").trim() : rest;
	return { id, status, text, dodRefs, lineIndex };
}

/**
 * Parse the optional `## Plan` section: a fourth, hand-maintained layer between the contract
 * (Goal/DoD/Manual/Verification) and the append-only Current Cycle/History log (spec 037, D2).
 *
 * Four checkbox states — `[ ]` todo, `[x]` done, `[!]` blocked, `[~]` dropped — and no separate
 * "doing" marker: the current step is *derived* (first `todo`/`blocked` in document order), not
 * self-reported, for the same reason `task-driver.ts`'s fingerprint excludes the model's own
 * progress notes — a runtime-derived signal cannot be talked into lying about itself.
 *
 * Returns `undefined` when there is no Plan heading, or the heading has no checkbox lines under
 * it (nothing to summarize) — both read the same as "this task has no Plan yet".
 */
export function parseTaskPlan(content: string): TaskPlanSummary | undefined {
	const lines = content.split("\n");
	const bounds = findTaskSectionBounds(lines, PLAN_SECTION_NAMES);
	if (!bounds) return undefined;

	const steps: TaskPlanStep[] = [];
	let position = 0;
	for (let index = bounds.headingIndex + 1; index < bounds.end; index++) {
		const line = lines[index] ?? "";
		if (!/^\s*[-*]\s+\[/.test(line)) continue;
		position++;
		const step = parsePlanStepLine(line, index, `P${position}`);
		if (step) steps.push(step);
	}
	if (steps.length === 0) return undefined;

	return {
		steps,
		total: steps.filter((step) => step.status !== "dropped").length,
		done: steps.filter((step) => step.status === "done").length,
		current: steps.find((step) => step.status === "todo" || step.status === "blocked"),
	};
}

export interface TaskPlanStepPatch {
	id: string;
	status?: TaskPlanStepStatus;
	text?: string;
}

export interface ApplyTaskPlanPatchResult {
	body: string;
	/** Human-readable delta, meant to be folded into the caller's Current Cycle note; `""` if nothing changed. */
	summary: string;
}

const PLAN_STATUS_MARKER: Record<TaskPlanStepStatus, string> = { todo: " ", done: "x", blocked: "!", dropped: "~" };

function renderPlanStepLine(id: string, status: TaskPlanStepStatus, text: string, dodRefs: number[] = []): string {
	const suffix = dodRefs.length > 0 ? ` → dod:${dodRefs.join(",")}` : "";
	return `- [${PLAN_STATUS_MARKER[status]}] ${id} ${text}${suffix}`;
}

/**
 * Insert an empty "## Plan" heading after the contract — immediately before "## 上次结果" when the
 * task has one, otherwise at the end. Spec 051 removed "## Current Cycle", which used to be the
 * anchor; a task with neither section simply gets its Plan appended rather than being rejected.
 */
function insertEmptyPlanSection(body: string): string {
	const lines = body.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (match && matchesTaskSectionTitle(match[2] ?? "", LAST_RESULT_SECTION_NAMES)) {
			lines.splice(index, 0, "## Plan", "");
			return lines.join("\n");
		}
	}
	return `${body.replace(/\n+$/, "")}\n\n## Plan\n`;
}

/**
 * Update or append Plan steps by id (spec 037, D3). An id that already exists gets its
 * status/text patched in place, preserving its `dod` refs and position; an unseen id is appended
 * as a new step (`text` is then required — there is nothing sensible to append otherwise). A task
 * with no `## Plan` section yet gets an empty one inserted before Current Cycle first, so the
 * very first `planSteps` call on a task is also the one that creates its Plan.
 *
 * The returned `summary` is deliberately not a new persisted field (see the file-level doc on
 * `TaskPlanSummary`): it is meant to be appended to the caller's own Current Cycle note, so the
 * change history rides on the log `startTaskCycle` already folds into History — no second,
 * unconsumed revision counter.
 */
export function applyTaskPlanPatch(body: string, patches: readonly TaskPlanStepPatch[]): ApplyTaskPlanPatchResult {
	if (patches.length === 0) return { body, summary: "" };

	let working = parseTaskPlan(body) ? body : insertEmptyPlanSection(body);
	const deltas: string[] = [];

	for (const patch of patches) {
		const trimmedId = patch.id.trim();
		if (!trimmedId) throw new RecoverableToolError("A planSteps entry's id must not be empty.");
		const existing = parseTaskPlan(working)?.steps.find((step) => step.id.toUpperCase() === trimmedId.toUpperCase());

		if (existing) {
			const lines = working.split("\n");
			const nextStatus = patch.status ?? existing.status;
			const nextText = patch.text?.trim() || existing.text;
			lines[existing.lineIndex] = renderPlanStepLine(existing.id, nextStatus, nextText, existing.dodRefs);
			working = lines.join("\n");
			deltas.push(patch.status ? `${existing.id}→${patch.status}` : `${existing.id} updated`);
			continue;
		}

		const text = patch.text?.trim();
		if (!text) {
			throw new RecoverableToolError(
				`Plan step "${trimmedId}" does not exist yet; adding a new step requires text.`,
			);
		}
		const id = trimmedId.toUpperCase();
		const lines = working.split("\n");
		const bounds = findTaskSectionBounds(lines, PLAN_SECTION_NAMES);
		let insertAt = bounds?.end ?? lines.length;
		const afterHeading = (bounds?.headingIndex ?? -1) + 1;
		while (insertAt > afterHeading && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
		lines.splice(insertAt, 0, renderPlanStepLine(id, patch.status ?? "todo", text));
		working = lines.join("\n");
		deltas.push(`+${id} ${text}`);
	}

	return { body: working, summary: deltas.length > 0 ? `plan: ${deltas.join("; ")}` : "" };
}

/** First `# ` heading after the frontmatter block, or the id when there is none. */
export function extractTaskTitle(content: string, fallbackId: string): string {
	for (const line of taskBody(content).split("\n")) {
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match) return match[1];
	}
	return fallbackId;
}

export function matchesTaskSectionTitle(title: string, names: readonly string[]): boolean {
	const normalized = title.trim().toLowerCase();
	return names.some((name) => {
		const expected = name.toLowerCase();
		return (
			normalized === expected ||
			normalized.startsWith(`${expected} `) ||
			normalized.startsWith(`${expected}(`) ||
			normalized.startsWith(`${expected}（`)
		);
	});
}

export interface TaskSectionBounds {
	/** Line index of the heading line itself. */
	headingIndex: number;
	/** Heading level, 1–6. */
	level: number;
	/** Exclusive end: the next heading at the same or a shallower level, or `lines.length`. */
	end: number;
}

/**
 * Find the first heading matching one of `names` and the exclusive end of its body — the next
 * heading at the same or a shallower level, or end of document. Every task-document section scan
 * (Plan, Current Cycle, DoD, Verification) shares this exact rule; only what a caller does with
 * the bounds differs.
 */
export function findTaskSectionBounds(
	lines: readonly string[],
	names: readonly string[],
): TaskSectionBounds | undefined {
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match || !matchesTaskSectionTitle(match[2] ?? "", names)) continue;
		const level = match[1]?.length ?? 0;
		let end = lines.length;
		for (let cursor = index + 1; cursor < lines.length; cursor++) {
			const headingMatch = /^(#{1,6})\s+/.exec(lines[cursor] ?? "");
			if (headingMatch && (headingMatch[1]?.length ?? 7) <= level) {
				end = cursor;
				break;
			}
		}
		return { headingIndex: index, level, end };
	}
	return undefined;
}

/**
 * For every line, which of `sections` (each a label plus its heading aliases) it falls under,
 * using the same heading-scoping rule as {@link findTaskSectionBounds}. A heading line itself is
 * never "in" a section. Shared by the per-line DoD/Verification scans below so the scoping rule
 * lives in exactly one place.
 */
function classifyTaskSectionLines<L extends string>(
	lines: readonly string[],
	sections: readonly { label: L; names: readonly string[] }[],
): (L | undefined)[] {
	const result: (L | undefined)[] = new Array(lines.length);
	let current: L | undefined;
	let currentLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (heading) {
			const level = heading[1]?.length ?? 7;
			const match = sections.find((section) => matchesTaskSectionTitle(heading[2] ?? "", section.names));
			if (match) {
				current = match.label;
				currentLevel = level;
			} else if (current && level <= currentLevel) {
				current = undefined;
			}
			continue;
		}
		result[index] = current;
	}
	return result;
}

export function hasTaskHeading(content: string, names: readonly string[]): boolean {
	return content.split("\n").some((line) => {
		const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
		return match ? matchesTaskSectionTitle(match[1] ?? "", names) : false;
	});
}

export function missingStandardTaskSections(content: string): string[] {
	return STANDARD_TASK_SECTIONS.filter((section) => !hasTaskHeading(content, section.names)).map(
		(section) => section.label,
	);
}

/**
 * Unchecked Markdown acceptance boxes under the DoD section, plus a synthetic
 * entry when DoD has content but no checkbox syntax at all.
 *
 * Without the "no checklist items" case, a DoD written as prose or a numbered
 * list (no `- [ ]` anywhere) makes this function return an empty array —
 * indistinguishable from "everything is checked" — which would silently let
 * `task_close outcome=complete` through with nothing ever actually verified.
 */
const DOD_VERIFICATION_SECTIONS = [
	{ label: "DoD" as const, names: ["DoD"] },
	{ label: "Verification" as const, names: ["Verification", "验收"] },
];

export function uncheckedTaskAcceptanceItems(content: string): string[] {
	const unchecked: string[] = [];
	const lines = content.split("\n");
	const sectionOf = classifyTaskSectionLines(lines, DOD_VERIFICATION_SECTIONS);
	let dodHasContent = false;
	let dodHasCheckbox = false;
	for (let index = 0; index < lines.length; index++) {
		const section = sectionOf[index];
		if (!section) continue;
		const line = lines[index] ?? "";
		if (section === "DoD" && line.trim()) dodHasContent = true;
		const checkbox = /^\s*[-*]\s+\[([ xX])\]\s*(.+?)\s*$/.exec(line);
		if (checkbox) {
			if (section === "DoD") dodHasCheckbox = true;
			if (checkbox[1] === " ") unchecked.push(`${section}: ${checkbox[2]}`);
		}
	}
	if (dodHasContent && !dodHasCheckbox) {
		unchecked.push(
			'DoD has no checklist items — rewrite it as "- [ ] ..." acceptance items before requesting verification or complete.',
		);
	}
	return unchecked;
}

/**
 * Count of checkbox items (checked or not) under the DoD heading, for cross-referencing a Plan
 * step's `→ dod:N` refs (spec 037, D4 — `/tasks doctor`'s drift checks).
 */
export function countTaskDodItems(content: string): number {
	const lines = content.split("\n");
	const sectionOf = classifyTaskSectionLines(lines, [{ label: "DoD" as const, names: ["DoD"] }]);
	let count = 0;
	for (let index = 0; index < lines.length; index++) {
		if (sectionOf[index] === "DoD" && /^\s*[-*]\s+\[[ xX]\]/.test(lines[index] ?? "")) count++;
	}
	return count;
}

/** A plain plan-step line gets an auto-assigned `P<n>` id unless it already starts with one. */
function ensurePlanStepId(line: string, fallbackIndex: number): string {
	return PLAN_STEP_ID_PREFIX.test(line) ? line : `P${fallbackIndex} ${line}`;
}

/**
 * The v4 task skeleton: contract only (spec 051, D5). `## Current Cycle` and `## History` are
 * gone — the per-step record lives in `<id>.jsonl`, and the one paragraph the contract keeps
 * (`## 上次结果`) is written by the cycle-close path, not by the skeleton.
 */
export function renderStandardTaskBody(input: TaskSkeletonInput): string {
	const manual = input.manual?.trim() || DEFAULT_TASK_MANUAL;
	const verificationPlan =
		input.verificationPlan?.trim() ||
		"- Check every DoD item against concrete evidence.\n- Run the relevant deterministic checks before declaring PASS.";
	const planLines = (input.plan ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return [
		`# ${input.title}`,
		"",
		"## Goal",
		input.goal,
		"",
		"## DoD",
		input.dod,
		"",
		"## Manual",
		manual,
		"",
		"## Verification",
		// Only stated when it constrains closing the task; an unverified task says nothing
		// rather than advertising a second, weaker mode (spec 036, D5).
		...(input.verificationRequired ? ["Independent verification: required"] : []),
		verificationPlan,
		"",
		// Plan is optional (spec 037, D2/D3): omitted entirely when create was not given one,
		// rather than rendering an empty section a doctor check would then have to special-case.
		...(planLines.length > 0
			? ["## Plan", ...planLines.map((line, index) => `- [ ] ${ensurePlanStepId(line, index + 1)}`), ""]
			: []),
	].join("\n");
}

/** Serialize a task document: v4 frontmatter block plus the body, unchanged. */
export function renderTaskDocument(fields: TaskFrontmatterV4, rawBody: string): string {
	return `${renderTaskFrontmatter(fields)}\n${rawBody}`;
}

/**
 * Reset a recurring task's per-cycle checkboxes: DoD/Verification acceptance items and Plan
 * steps both go back to unchecked, so cycle N+1 can never pass its acceptance gate on cycle N's
 * evidence. `[~]` dropped plan steps are left alone — that step was deliberately abandoned, not
 * merely finished, and a new cycle should not resurrect it.
 */
export function resetTaskPlanForCycle(body: string): string {
	const lines = body.split("\n");
	const sectionOf = classifyTaskSectionLines(lines, DOD_VERIFICATION_SECTIONS);
	for (let index = 0; index < lines.length; index++) {
		if (!sectionOf[index]) continue;
		const checkbox = /^(\s*[-*]\s+)\[[xX]\](\s*.*)$/.exec(lines[index] ?? "");
		if (checkbox) lines[index] = `${checkbox[1]}[ ]${checkbox[2]}`;
	}
	const bounds = findTaskSectionBounds(lines, PLAN_SECTION_NAMES);
	if (bounds) {
		for (let index = bounds.headingIndex + 1; index < bounds.end; index++) {
			const checkbox = /^(\s*[-*]\s+)\[[xX!]\](\s*.*)$/.exec(lines[index] ?? "");
			if (checkbox) lines[index] = `${checkbox[1]}[ ]${checkbox[2]}`;
		}
	}
	return lines.join("\n");
}

/**
 * Runnable first; then a parked task whose backstop already expired (the runtime owes it a
 * reopen); then earliest due ticket; then id. Sorting expired parks ahead of ordinary parks is
 * what keeps D2-INV's deadline honest when a channel has more ready work than one tick can carry.
 */
export function compareTaskEntries(a: TaskLedgerEntry, b: TaskLedgerEntry): number {
	if (a.runnable !== b.runnable) return a.runnable ? -1 : 1;
	if (a.expired !== b.expired) return a.expired ? -1 : 1;
	const paused = (entry: TaskLedgerEntry) => (entry.fields.paused ? 1 : 0);
	if (paused(a) !== paused(b)) return paused(a) - paused(b);
	const due = (entry: TaskLedgerEntry) => entry.dueMs ?? Number.POSITIVE_INFINITY;
	if (due(a) !== due(b)) return due(a) - due(b);
	return a.id.localeCompare(b.id);
}

function toEntry(id: string, content: string): Omit<TaskLedgerEntry, "runnable" | "dueMs" | "expired"> {
	const parsed = parseTaskFrontmatterV4(content);
	return {
		id,
		title: extractTaskTitle(content, id),
		fields: parsed.fields,
		readable: parsed.readable,
		legacy: parsed.legacy,
		plan: parseTaskPlan(content),
	};
}

/** The clock-dependent half of an entry, recomputed on every read (never cached). */
function withClock(entry: Omit<TaskLedgerEntry, "runnable" | "dueMs" | "expired">, now: number): TaskLedgerEntry {
	const nowDate = new Date(now);
	const ticket = entry.fields.ticket;
	return {
		...entry,
		runnable: isTaskRunnable(entry.fields),
		dueMs: ticket ? ticketDueMs(ticket) : undefined,
		expired: ticket !== undefined && !entry.fields.paused && ticketExpired(ticket, nowDate),
	};
}

/**
 * Parsed task files, keyed by path and invalidated by (mtime, ctime, size) — the same
 * fingerprint the memory candidate store uses.
 *
 * The task driver re-reads every channel's whole ledger on every tick *and* after every turn
 * (`nudge`), so an unchanged file was being read and re-parsed many times per minute. Only the
 * clock-dependent fields are recomputed per call; the parse itself is cached.
 *
 * Cached entries are handed out by reference, which is safe because every consumer of
 * `readActiveTasks` only reads: the read-modify-write path goes through `readStoredTask`, which
 * always reads the file itself. Treat entries from here as immutable.
 */
interface CachedTaskParse {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	entry: Omit<TaskLedgerEntry, "runnable" | "dueMs" | "expired">;
}

const parseCache = new Map<string, CachedTaskParse>();
/** Bound the cache for a long-lived daemon: far above any real ledger, and cheap to refill. */
const PARSE_CACHE_LIMIT = 512;

async function readEntry(path: string, id: string, now: number): Promise<TaskLedgerEntry> {
	const stats = await stat(path);
	const cached = parseCache.get(path);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.size === stats.size) {
		return withClock(cached.entry, now);
	}
	const entry = toEntry(id, await readFile(path, "utf-8"));
	if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
	parseCache.set(path, { mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size, entry });
	return withClock(entry, now);
}

/**
 * Read every `.md` file in `tasks/` (root only — the `archive/` subdirectory is not
 * scanned), returning entries sorted runnable-first. A file that cannot be read is still
 * returned (fail-open: `readable: false`, `runnable: true`) so problems surface.
 * Missing directory → empty list.
 */
export async function readActiveTasks(tasksDir: string, now: number = Date.now()): Promise<TaskLedgerEntry[]> {
	let dirents: Dirent[];
	try {
		dirents = await readdir(tasksDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const entries: TaskLedgerEntry[] = [];
	for (const dirent of dirents) {
		if (!dirent.isFile() || !dirent.name.endsWith(".md")) continue;
		const id = dirent.name.slice(0, -".md".length);
		const path = join(tasksDir, dirent.name);
		try {
			entries.push(await readEntry(path, id, now));
		} catch {
			parseCache.delete(path);
			entries.push({
				id,
				title: id,
				fields: { state: "open" },
				readable: false,
				legacy: false,
				runnable: true,
				expired: false,
			});
		}
	}

	entries.sort(compareTaskEntries);
	return entries;
}
