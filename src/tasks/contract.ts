import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { normalizeSafeId } from "../shared/safe-id.js";
import { isTaskRunnable, parseTaskFrontmatter, renderTaskFrontmatter, type TaskFrontmatter } from "./frontmatter.js";

import { ticketDueMs, ticketExpired } from "./ticket.js";

/**
 * Shared reader for the task ledger (`workspace/<channelId>/tasks/*.md`).
 *
 * The parsing stays deliberately literal (flat `key: value` fields, live-vs-archived, fail-open
 * on unreadable frontmatter) because task files are hand-editable and must degrade toward "wake
 * me up so I can be fixed". `/tasks`, the task digest, and `task_list` all read through here.
 *
 * Frontmatter lives in `frontmatter.ts` and the waiting claim in `ticket.ts`; what stays here is
 * the *body*: sections, Work Items, DoD, and the skeleton.
 */

export interface TaskLedgerEntry {
	/** Filename without `.md`; the task id. */
	id: string;
	/** First `# ` heading in the body, or the id when none. */
	title: string;
	fields: TaskFrontmatter;
	/** false => frontmatter could not be read; the task is surfaced rather than skipped. */
	readable: boolean;
	/** True when this file still carries v3 frontmatter the conversion should have removed; it is never run. */
	legacy: boolean;
	/** The driver may schedule a step for this task right now. */
	runnable: boolean;
	/** When a driver-polled `time` ticket comes due, if it has not already. */
	dueMs?: number;
	/** True when a parked task's backstop has passed and the runtime owes it a reopen. */
	expired: boolean;
	/** Parsed `## Work Items` section, if the task has one. */
	items?: TaskItemsSummary;
}

export interface TaskContractInput {
	title: string;
	goal: string;
	dod: string;
	/** Initial Work Items; ids are assigned `W1…Wn` in order. */
	items?: readonly { text: string }[];
}

const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/** `## Work Items` is deliberately optional: a two-step task or an item-less template simply has none. */
const ITEMS_SECTION_NAMES = ["Work Items", "工作项"] as const;
const ITEMS_HEADING = "## Work Items";

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

export type TaskItemStatus = "todo" | "done" | "blocked" | "dropped";

export interface TaskItem {
	/** `W<n>` (a task converted from v3 may still carry `P<n>`). */
	id: string;
	status: TaskItemStatus;
	text: string;
	/** DoD checklist items (1-based) this item delivers, from a trailing `→ dod:1,2`. */
	dodRefs: number[];
	/** Line index within the parsed content; used to patch a line in place. */
	lineIndex: number;
}

export interface TaskItemsSummary {
	items: TaskItem[];
	/** Count of items, excluding `dropped` ones. */
	total: number;
	done: number;
	/** The first `todo` or `blocked` item in document order; `undefined` once nothing is left to do. */
	current?: TaskItem;
}

const ITEM_STATUS_BY_MARKER: Record<string, TaskItemStatus> = {
	" ": "todo",
	x: "done",
	X: "done",
	"!": "blocked",
	"~": "dropped",
};
const ITEM_MARKER_BY_STATUS: Record<TaskItemStatus, string> = { todo: " ", done: "x", blocked: "!", dropped: "~" };
const ITEM_CHECKBOX_LINE = /^\s*[-*]\s+\[([ xX!~])\]\s+(.*)$/;
const ITEM_ID_PREFIX = /^([PW]\d+)[.、)]?\s+(\S.*)$/i;
const ITEM_DOD_REF_SUFFIX = /(?:→|->)\s*dod:\s*([\d,\s]+)\s*$/i;

function parseItemLine(line: string, lineIndex: number, fallbackId: string): TaskItem | undefined {
	const checkbox = ITEM_CHECKBOX_LINE.exec(line);
	if (!checkbox) return undefined;
	const status = ITEM_STATUS_BY_MARKER[checkbox[1] ?? " "] ?? "todo";
	let rest = (checkbox[2] ?? "").trim();

	let dodRefs: number[] = [];
	const dodMatch = ITEM_DOD_REF_SUFFIX.exec(rest);
	if (dodMatch) {
		dodRefs = (dodMatch[1] ?? "")
			.split(",")
			.map((part) => Number.parseInt(part.trim(), 10))
			.filter((n) => Number.isInteger(n) && n > 0);
		rest = rest.slice(0, dodMatch.index).trim();
	}

	const idMatch = ITEM_ID_PREFIX.exec(rest);
	const id = idMatch ? (idMatch[1] ?? fallbackId).toUpperCase() : fallbackId;
	const text = idMatch ? (idMatch[2] ?? "").trim() : rest;
	return { id, status, text, dodRefs, lineIndex };
}

/**
 * Parse the optional `## Work Items` section: the leader's hand-maintained list of independently
 * deliverable pieces of the project. Four checkbox states — `[ ]` todo, `[x]` done, `[!]`
 * blocked, `[~]` dropped — and no separate "doing" marker: the current item is *derived* (first
 * `todo`/`blocked` in document order), not self-reported. The runtime never ticks an item itself
 * (spec 052, D4): "the delegate says it is done" and "the leader checked it" are different facts.
 *
 * Returns `undefined` when there is no such heading, or it has no checkbox lines under it.
 */
export function parseTaskItems(content: string): TaskItemsSummary | undefined {
	const lines = content.split("\n");
	const bounds = findTaskSectionBounds(lines, ITEMS_SECTION_NAMES);
	if (!bounds) return undefined;

	const items: TaskItem[] = [];
	let position = 0;
	for (let index = bounds.headingIndex + 1; index < bounds.end; index++) {
		const line = lines[index] ?? "";
		if (!/^\s*[-*]\s+\[/.test(line)) continue;
		position++;
		const item = parseItemLine(line, index, `W${position}`);
		if (item) items.push(item);
	}
	if (items.length === 0) return undefined;

	return {
		items,
		total: items.filter((item) => item.status !== "dropped").length,
		done: items.filter((item) => item.status === "done").length,
		current: items.find((item) => item.status === "todo" || item.status === "blocked"),
	};
}

export interface TaskItemPatch {
	id: string;
	status?: TaskItemStatus;
	text?: string;
}

export interface ApplyTaskItemsPatchResult {
	body: string;
	/** Human-readable delta for the tool's notice; `""` if nothing changed. */
	summary: string;
}

function renderItemLine(id: string, status: TaskItemStatus, text: string, dodRefs: number[] = []): string {
	const suffix = dodRefs.length > 0 ? ` → dod:${dodRefs.join(",")}` : "";
	return `- [${ITEM_MARKER_BY_STATUS[status]}] ${id} ${text}${suffix}`;
}

/** Append an empty `## Work Items` heading at the end of the contract. */
function appendEmptyItemsSection(body: string): string {
	return `${body.replace(/\n+$/, "")}\n\n${ITEMS_HEADING}\n`;
}

/**
 * Update or append Work Items by id. An id that already exists gets its status/text patched in
 * place, preserving its `dod` refs and position; an unseen id is appended as a new item (`text`
 * is then required — there is nothing sensible to append otherwise). A task with no section yet
 * gets an empty one first, so the very first `items` call on a task is also the one that creates
 * its list.
 */
export function applyTaskItemsPatch(body: string, patches: readonly TaskItemPatch[]): ApplyTaskItemsPatchResult {
	if (patches.length === 0) return { body, summary: "" };

	let working = parseTaskItems(body) ? body : appendEmptyItemsSection(body);
	const deltas: string[] = [];

	for (const patch of patches) {
		const trimmedId = patch.id.trim();
		if (!trimmedId) throw new RecoverableToolError("An items entry's id must not be empty.");
		const existing = parseTaskItems(working)?.items.find((item) => item.id.toUpperCase() === trimmedId.toUpperCase());

		if (existing) {
			const lines = working.split("\n");
			const nextStatus = patch.status ?? existing.status;
			const nextText = patch.text?.trim() || existing.text;
			lines[existing.lineIndex] = renderItemLine(existing.id, nextStatus, nextText, existing.dodRefs);
			working = lines.join("\n");
			deltas.push(patch.status ? `${existing.id}→${patch.status}` : `${existing.id} updated`);
			continue;
		}

		const text = patch.text?.trim();
		if (!text) {
			throw new RecoverableToolError(
				`Work item "${trimmedId}" does not exist yet; adding a new item requires text.`,
			);
		}
		const id = trimmedId.toUpperCase();
		const lines = working.split("\n");
		const bounds = findTaskSectionBounds(lines, ITEMS_SECTION_NAMES);
		let insertAt = bounds?.end ?? lines.length;
		const afterHeading = (bounds?.headingIndex ?? -1) + 1;
		while (insertAt > afterHeading && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
		lines.splice(insertAt, 0, renderItemLine(id, patch.status ?? "todo", text));
		working = lines.join("\n");
		deltas.push(`+${id} ${text}`);
	}

	return { body: working, summary: deltas.length > 0 ? `items: ${deltas.join("; ")}` : "" };
}

/** Whether `id` names an existing Work Item of the task body (case-insensitive). */
export function findTaskItem(body: string, id: string): TaskItem | undefined {
	return parseTaskItems(body)?.items.find((item) => item.id.toUpperCase() === id.trim().toUpperCase());
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
 * (Work Items, DoD) shares this exact rule; only what a caller does with
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
 * never "in" a section.
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

const DOD_SECTION = [{ label: "DoD" as const, names: ["DoD"] }];

/**
 * Unchecked Markdown acceptance boxes under the DoD section, plus a synthetic entry when DoD has
 * content but no checkbox syntax at all.
 *
 * Without the "no checklist items" case, a DoD written as prose or a numbered list (no `- [ ]`
 * anywhere) makes this function return an empty array — indistinguishable from "everything is
 * checked" — which would silently let a task close with nothing ever actually checked.
 */
export function uncheckedTaskAcceptanceItems(content: string): string[] {
	const unchecked: string[] = [];
	const lines = content.split("\n");
	const sectionOf = classifyTaskSectionLines(lines, DOD_SECTION);
	let dodHasContent = false;
	let dodHasCheckbox = false;
	for (let index = 0; index < lines.length; index++) {
		if (!sectionOf[index]) continue;
		const line = lines[index] ?? "";
		if (line.trim()) dodHasContent = true;
		const checkbox = /^\s*[-*]\s+\[([ xX])\]\s*(.+?)\s*$/.exec(line);
		if (checkbox) {
			dodHasCheckbox = true;
			if (checkbox[1] === " ") unchecked.push(`DoD: ${checkbox[2]}`);
		}
	}
	if (dodHasContent && !dodHasCheckbox) {
		unchecked.push('DoD has no checklist items — rewrite it as "- [ ] ..." acceptance items before finishing.');
	}
	return unchecked;
}

/**
 * The task skeleton: Goal, DoD and (optionally) Work Items (spec 052, §3.4). The runtime never
 * rewrites the body afterwards, so there is no history section here — the per-step record lives
 * in `<id>.jsonl`.
 */
export function renderStandardTaskBody(input: TaskContractInput): string {
	const itemLines = (input.items ?? []).map((item) => item.text.trim()).filter(Boolean);
	return [
		`# ${input.title}`,
		"",
		"## Goal",
		input.goal,
		"",
		"## DoD",
		input.dod,
		"",
		...(itemLines.length > 0
			? [ITEMS_HEADING, ...itemLines.map((text, index) => renderItemLine(`W${index + 1}`, "todo", text)), ""]
			: []),
	].join("\n");
}

/** Serialize a task document: frontmatter block plus the body, unchanged. */
export function renderTaskDocument(fields: TaskFrontmatter, rawBody: string): string {
	return `${renderTaskFrontmatter(fields)}\n${rawBody}`;
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
	const parsed = parseTaskFrontmatter(content);
	return {
		id,
		title: extractTaskTitle(content, id),
		fields: parsed.fields,
		readable: parsed.readable,
		legacy: parsed.legacy,
		items: parseTaskItems(content),
	};
}

/** The clock-dependent half of an entry, recomputed on every read (never cached). */
function withClock(entry: Omit<TaskLedgerEntry, "runnable" | "dueMs" | "expired">, now: number): TaskLedgerEntry {
	const nowDate = new Date(now);
	const ticket = entry.fields.ticket;
	return {
		...entry,
		runnable: isTaskRunnable(entry.fields) && !entry.legacy,
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
