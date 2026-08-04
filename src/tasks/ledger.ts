import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { nextTaskWake } from "../shared/task-schedule.js";
import { createDefaultTaskControl, parseTaskControl, type TaskControl, taskPriorityRank } from "./control.js";
import { normalizeStoredStatus, wasLegacyEscalated } from "./transitions.js";

export type TaskArchiveOutcome = "completed" | "cancelled";

/**
 * Shared reader for the task ledger (`workspace/<channelId>/tasks/*.md`).
 *
 * This is the sole implementation of the frontmatter contract documented in
 * `docs/events-and-tasks.md` ("Frontmatter 契约（单一事实源）"). It used to be one of two
 * halves — a dependency-free `tasks-pending.mjs` sensor under workspace/skills was the
 * other — but the native TaskDriver (spec 022) replaced that sensor, so `actionable` now
 * has a single owner. The parsing stays deliberately literal (flat `key: value` fields,
 * live-vs-archived, wake gating, fail-open on unreadable frontmatter) because task files
 * are hand-editable and must degrade toward "wake me up so I can be fixed".
 * `/tasks`, the task digest, and `task_manage list` all read through here.
 */

export interface TaskFrontmatter {
	/** false => frontmatter could not be read (fail-open: the task is treated as actionable). */
	readable: boolean;
	status?: string;
	/** Raw status before the v1 reader migration, for deterministic startup migration/doctor. */
	rawStatus?: string;
	/** True when a legacy terminal file in the active directory needs archiving. */
	archiveOutcome?: TaskArchiveOutcome;
	closedAt?: string;
	enabled: boolean;
	wake?: string;
	/** Five-field cron cadence (host timezone). Present ⇒ this is a recurring task. */
	schedule?: string;
	recurrence?: string;
	control?: TaskControl;
	/** false only when a control field exists but cannot be parsed/validated. */
	controlReadable?: boolean;
	/**
	 * The control block exactly as stored, before `parseTaskControl` drops retired keys.
	 * `/tasks doctor` needs this to report what an older build wrote (spec 036, D8) — the
	 * parsed `control` above cannot show a key whose whole point is that it is now ignored.
	 */
	rawControl?: unknown;
}

export interface TaskLedgerEntry {
	/** Filename without `.md`; the task id. */
	id: string;
	/** First `# ` heading in the body, or the id when none. */
	title: string;
	frontmatter: TaskFrontmatter;
	/** Non-terminal, not parked (`waiting` without a wake), and (no valid wake OR wake ≤ now). */
	actionable: boolean;
	/** Milliseconds since epoch parsed from `wake`, or undefined when unset/unparseable. */
	wakeMs?: number;
	/** First bullet/line under a "当前周期"/"current cycle" heading, if any (digest only). */
	latestNote?: string;
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

const FRONTMATTER_FIELDS = [
	"status",
	"enabled",
	"wake",
	"schedule",
	"recurrence",
	"outcome",
	"closedAt",
	"control",
] as const;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_TASK_MANUAL =
	"- Follow the DoD, keep the current cycle log updated, and schedule check-ins when waiting.";

export const STANDARD_TASK_SECTIONS = [
	{ label: "Goal", names: ["Goal", "目标"] },
	{ label: "DoD", names: ["DoD"] },
	{ label: "Manual", names: ["Manual", "手册"] },
	{ label: "Verification", names: ["Verification", "验收"] },
	{ label: "Current Cycle", names: ["Current Cycle", "当前周期"] },
	{ label: "History", names: ["History", "历史"] },
] as const;

/**
 * `## Plan` is a deliberately optional section (spec 037, D2) — it is not part of
 * `STANDARD_TASK_SECTIONS`, so `missingStandardTaskSections` never flags its absence. A two-step
 * task or any pre-existing task simply has no Plan.
 */
const PLAN_SECTION_NAMES = ["Plan", "计划"] as const;

/** Recurring task files are working context, not an unbounded audit log. */
export const MAX_INLINE_TASK_HISTORY_ENTRIES = 8;
export const MAX_INLINE_TASK_HISTORY_CHARS = 24 * 1024;
const MAX_INLINE_TASK_HISTORY_ENTRY_CHARS = 4 * 1024;
const HISTORY_OMISSION_NOTE =
	"- Older cycle details omitted from working context; use session_search with the task id or cycle id to inspect cold history.";
const HISTORY_TRUNCATION_NOTE =
	"- Entry truncated in working context; use session_search with the task id or cycle id to inspect the complete cold history.";

/** Validate/normalize a task id (filename without `.md`), rejecting path traversal. */
export function normalizeTaskId(id: string): string {
	const trimmed = id.trim();
	const normalized = trimmed.endsWith(".md") ? trimmed.slice(0, -".md".length) : trimmed;
	if (!normalized || normalized === "." || normalized === ".." || !TASK_ID_PATTERN.test(normalized)) {
		throw new Error(`Invalid task id: ${id}`);
	}
	return normalized;
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
 * The task's *contract* segment: the body up to (excluding) whichever of "Plan" or "Current
 * Cycle" appears first — i.e. the H1 title, Goal, DoD (with its checkbox state), Manual and
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
				matchesTaskSectionTitle(match[1] ?? "", ["Current Cycle", "当前周期"]))
		) {
			return lines.slice(0, index).join("\n").replace(/\s+$/, "");
		}
	}
	return body;
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
	let sectionStart = -1;
	let sectionLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match || !matchesTaskSectionTitle(match[2] ?? "", PLAN_SECTION_NAMES)) continue;
		sectionStart = index;
		sectionLevel = match[1]?.length ?? 0;
		break;
	}
	if (sectionStart === -1) return undefined;

	let sectionEnd = lines.length;
	for (let index = sectionStart + 1; index < lines.length; index++) {
		const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
		if (match && (match[1]?.length ?? 7) <= sectionLevel) {
			sectionEnd = index;
			break;
		}
	}

	const steps: TaskPlanStep[] = [];
	let position = 0;
	for (let index = sectionStart + 1; index < sectionEnd; index++) {
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

/** Insert an empty "## Plan" heading immediately before "## Current Cycle" (spec 037, D3). */
function insertEmptyPlanSection(body: string): string {
	const lines = body.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (match && matchesTaskSectionTitle(match[2] ?? "", ["Current Cycle", "当前周期"])) {
			lines.splice(index, 0, "## Plan", "");
			return lines.join("\n");
		}
	}
	throw new RecoverableToolError(
		'Task body has no "Current Cycle" section, so a Plan cannot be inserted; normalize the task skeleton with edit first.',
	);
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
		let sectionStart = -1;
		let sectionLevel = 0;
		for (let index = 0; index < lines.length; index++) {
			const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
			if (match && matchesTaskSectionTitle(match[2] ?? "", PLAN_SECTION_NAMES)) {
				sectionStart = index;
				sectionLevel = match[1]?.length ?? 0;
				break;
			}
		}
		let insertAt = lines.length;
		for (let index = sectionStart + 1; index < lines.length; index++) {
			const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
			if (match && (match[1]?.length ?? 7) <= sectionLevel) {
				insertAt = index;
				break;
			}
		}
		while (insertAt > sectionStart + 1 && (lines[insertAt - 1] ?? "").trim() === "") insertAt--;
		lines.splice(insertAt, 0, renderPlanStepLine(id, patch.status ?? "todo", text));
		working = lines.join("\n");
		deltas.push(`+${id} ${text}`);
	}

	return { body: working, summary: deltas.length > 0 ? `plan: ${deltas.join("; ")}` : "" };
}

/** Parse the leading frontmatter block and normalize legacy v1 fields in memory. */
export function parseTaskFrontmatter(content: string): TaskFrontmatter {
	if (!content.startsWith("---")) return { readable: false, enabled: true };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { readable: false, enabled: true };

	const block = content.slice(3, end);
	const frontmatter: TaskFrontmatter = { readable: true, enabled: true };
	for (const line of block.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		if ((FRONTMATTER_FIELDS as readonly string[]).includes(key)) {
			const value = line.slice(idx + 1).trim();
			if (key === "control") {
				if (!value) {
					frontmatter.controlReadable = false;
				} else {
					try {
						frontmatter.rawControl = JSON.parse(value);
					} catch {
						// Leave rawControl unset; the parse below reports the real problem.
					}
					try {
						frontmatter.control = parseTaskControl(value);
						frontmatter.controlReadable = true;
					} catch {
						frontmatter.controlReadable = false;
					}
				}
			} else if (key === "enabled") {
				frontmatter.enabled = value !== "false";
			} else if (key === "outcome") {
				if (value === "completed" || value === "cancelled") frontmatter.archiveOutcome = value;
			} else if (key === "closedAt") {
				frontmatter.closedAt = value || undefined;
			} else if (key === "status" || key === "wake" || key === "schedule" || key === "recurrence") {
				frontmatter[key] = value || undefined;
			}
		}
	}
	// Canonicalise the possibly legacy status on read. Terminal v1 values are marked as archive
	// outcomes so an active-directory scan can never execute them before startup migration moves
	// them. A legacy recurring terminal is the v2 sleeping state.
	const rawStatus = frontmatter.status;
	frontmatter.rawStatus = rawStatus;
	if (frontmatter.readable) {
		if (rawStatus === "done" && !frontmatter.schedule) frontmatter.archiveOutcome = "completed";
		if (rawStatus === "cancelled") frontmatter.archiveOutcome = "cancelled";
		frontmatter.status = normalizeStoredStatus(rawStatus, Boolean(frontmatter.schedule));
		if (rawStatus === "paused" || wasLegacyEscalated(rawStatus)) {
			frontmatter.enabled = false;
			frontmatter.control ??= createDefaultTaskControl();
			if (frontmatter.control && !frontmatter.control.stop) {
				frontmatter.control.stop = {
					by: wasLegacyEscalated(rawStatus) ? "governor" : "user",
					reason:
						frontmatter.control.blockedReason ??
						`Task stopped by ${wasLegacyEscalated(rawStatus) ? "governor" : "user"}.`,
					at: formatLocalTime(),
				};
			}
		}
	}
	return frontmatter;
}

/**
 * The single shared judgement: is there work to do on this task right now?
 * Unreadable frontmatter is fail-open (actionable) so a corrupt ledger surfaces
 * rather than being silently skipped.
 *
 * `waiting` with no `wake` is the *parked* form (`src/tasks/transitions.ts`): the task is
 * blocked on an external signal — a background job finishing, the user answering, `/tasks run` —
 * and only that signal may resume it. Without this the runtime's own recommended shape for
 * delegating work (start a blocking wait as a `bash async` job, park the task, end the turn)
 * was re-dispatched the instant the turn ended, found the job still running, answered
 * `[SILENT]`, and after three such wakes was disabled by the governor. A `waiting` task that
 * *does* carry a wake is an ordinary timed re-check and stays gated on that wake; an
 * unparseable wake still fails open so a hand-edited file surfaces rather than parks forever.
 */
/** `waiting` with no `wake`: the driver will not come back on its own. See `isTaskActionable`. */
export function isTaskParked(frontmatter: TaskFrontmatter): boolean {
	return frontmatter.readable && frontmatter.status === "waiting" && !frontmatter.wake;
}

export function isTaskActionable(frontmatter: TaskFrontmatter, now: number): boolean {
	if (!frontmatter.readable) return true;
	if (frontmatter.controlReadable === false) return true;
	if (frontmatter.archiveOutcome || frontmatter.enabled === false) return false;
	// status is already canonicalised by parseTaskFrontmatter.
	if (frontmatter.status === "sleeping") {
		const wakeAt = parseWakeMs(frontmatter);
		return wakeAt !== undefined && wakeAt <= now;
	}
	if (isTaskParked(frontmatter)) return false;
	const wakeAt = parseWakeMs(frontmatter);
	if (wakeAt !== undefined && wakeAt > now) return false;
	return true;
}

/** First `# ` heading after the frontmatter block, or the id when there is none. */
export function extractTaskTitle(content: string, fallbackId: string): string {
	for (const line of taskBody(content).split("\n")) {
		const match = /^#\s+(.+?)\s*$/.exec(line);
		if (match) return match[1];
	}
	return fallbackId;
}

function matchesTaskSectionTitle(title: string, names: readonly string[]): boolean {
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
 * `task_manage request-verification`/`complete` through with nothing ever actually verified.
 */
export function uncheckedTaskAcceptanceItems(content: string): string[] {
	const unchecked: string[] = [];
	let section: "DoD" | "Verification" | undefined;
	let sectionLevel = 0;
	let dodHasContent = false;
	let dodHasCheckbox = false;
	for (const line of content.split("\n")) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const level = heading[1]?.length ?? 7;
			if (matchesTaskSectionTitle(heading[2] ?? "", ["DoD"])) {
				section = "DoD";
				sectionLevel = level;
			} else if (matchesTaskSectionTitle(heading[2] ?? "", ["Verification", "验收"])) {
				section = "Verification";
				sectionLevel = level;
			} else if (section && level <= sectionLevel) {
				section = undefined;
			}
			continue;
		}
		if (!section) continue;
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
	let inDod = false;
	let sectionLevel = 0;
	let count = 0;
	for (const line of content.split("\n")) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const level = heading[1]?.length ?? 7;
			if (matchesTaskSectionTitle(heading[2] ?? "", ["DoD"])) {
				inDod = true;
				sectionLevel = level;
			} else if (inDod && level <= sectionLevel) {
				inDod = false;
			}
			continue;
		}
		if (inDod && /^\s*[-*]\s+\[[ xX]\]/.test(line)) count++;
	}
	return count;
}

/** A plain plan-step line gets an auto-assigned `P<n>` id unless it already starts with one. */
function ensurePlanStepId(line: string, fallbackIndex: number): string {
	return PLAN_STEP_ID_PREFIX.test(line) ? line : `P${fallbackIndex} ${line}`;
}

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
		"## Current Cycle",
		"- Created; next step: start work and append progress here before ending each turn.",
		"",
		"## History",
		"",
	].join("\n");
}

export interface TaskDocumentFields {
	status: string;
	/** Raw v1 value retained only in memory for startup migration. */
	legacyStatus?: string;
	enabled?: boolean;
	wake?: string;
	schedule?: string;
	recurrence?: string;
	control?: TaskControl;
	outcome?: TaskArchiveOutcome;
	closedAt?: string;
}

/**
 * Enforce the v2 write-path invariants. Runtime due transitions are intentionally separate: a
 * waiting task is first written active, and a sleeping task is first opened into a cycle, before
 * the driver dispatches anything.
 */
export function normalizeTaskFields(fields: TaskDocumentFields, now: Date = new Date()): TaskDocumentFields {
	const next: TaskDocumentFields = {
		...fields,
		status: normalizeStoredStatus(fields.status, Boolean(fields.schedule)),
		enabled: fields.enabled !== false,
	};
	if (next.outcome) {
		// Archive documents are never driver inputs. Do not carry a live stop marker into them.
		next.enabled = undefined;
		return next;
	}
	if (next.enabled === true && next.control?.stop) {
		next.control = { ...next.control, stop: undefined };
	}
	if (next.enabled === false) {
		// Pausing is intentionally lossless: do not normalize status, wake, or schedule while disabled.
		// A hand-written disabled task without a stop receipt is diagnosed rather than given a fabricated actor.
		return next;
	}

	const nowMs = now.getTime();
	const wakeMs = next.wake ? parseLocalTime(next.wake) : undefined;
	if (next.status === "active") {
		if (wakeMs !== undefined && wakeMs > nowMs) {
			next.status = "waiting";
			next.control = next.control ? { ...next.control, waitingFor: "time" } : undefined;
		} else {
			next.wake = undefined;
			next.control = next.control ? { ...next.control, waitingFor: undefined } : undefined;
		}
	}
	if (next.status === "waiting") {
		if (next.wake && wakeMs !== undefined) {
			const waitingFor = next.control?.waitingFor === "external-signal" ? "external-signal" : "time";
			next.control = next.control ? { ...next.control, waitingFor } : undefined;
		} else if (!next.wake && next.control) {
			const waitingFor = next.control.waitingFor === "time" ? "external-signal" : next.control.waitingFor;
			next.control = { ...next.control, waitingFor: waitingFor ?? "external-signal" };
		}
	}
	if (next.status === "sleeping" && next.schedule) {
		const occurrence = next.wake ? parseLocalTime(next.wake) : undefined;
		const validOccurrence =
			occurrence !== undefined && nextTaskWake(next.schedule, new Date(occurrence - 1))?.getTime() === occurrence;
		if (!validOccurrence) {
			const upcoming = nextTaskWake(next.schedule, now);
			if (upcoming) next.wake = formatLocalTime(upcoming);
		}
		if (next.control?.waitingFor) {
			next.control = { ...next.control, waitingFor: undefined };
		}
	}
	return next;
}

/**
 * Whether an open recurring cycle has already crossed its next schedule occurrence.
 * The runtime must keep working on the old cycle rather than opening a concurrent one.
 * Cycle ids intentionally carry the local calendar date; the optional suffix handles a
 * same-day manual reopen deterministically.
 */
export function recurringTaskMissedOccurrence(fields: TaskDocumentFields, now: Date = new Date()): boolean {
	if (!fields.schedule || (fields.status !== "active" && fields.status !== "waiting") || !fields.control?.cycleId) {
		return false;
	}
	const match = /^cycle-(\d{4})-(\d{2})-(\d{2})(?:-(\d+))?$/.exec(fields.control.cycleId);
	if (!match) return false;
	const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	if (!Number.isFinite(start.getTime())) return false;
	let occurrence = nextTaskWake(fields.schedule, new Date(start.getTime() - 1));
	const count = match[4] ? Number.parseInt(match[4], 10) : 1;
	for (let index = 1; occurrence && index < count; index++) {
		occurrence = nextTaskWake(fields.schedule, occurrence);
	}
	const next = occurrence ? nextTaskWake(fields.schedule, occurrence) : undefined;
	return next !== undefined && next.getTime() <= now.getTime();
}

export function renderTaskDocument(fields: TaskDocumentFields, rawBody: string): string {
	const document = normalizeTaskFields(fields);
	const lines = ["---"];
	if (document.outcome) {
		lines.push(`outcome: ${document.outcome}`);
		if (document.closedAt) lines.push(`closedAt: ${document.closedAt}`);
	} else {
		lines.push(`status: ${document.status}`, `enabled: ${document.enabled !== false}`);
	}
	if (document.wake) lines.push(`wake: ${document.wake}`);
	if (document.schedule) lines.push(`schedule: ${document.schedule}`);
	if (document.recurrence) lines.push(`recurrence: ${document.recurrence}`);
	if (document.control) lines.push(`control: ${JSON.stringify(document.control)}`);
	lines.push("---");
	return `${lines.join("\n")}\n${rawBody}`;
}

/** Append one progress bullet to the standard Current Cycle section. */
export function appendCurrentCycleNote(content: string, note: string): string {
	const trimmedNote = note.trim().replace(/\s+/g, " ");
	if (!trimmedNote) {
		throw new Error("Current Cycle note must not be empty.");
	}

	const lines = content.split("\n");
	let sectionStart = -1;
	let sectionLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match || !matchesTaskSectionTitle(match[2] ?? "", ["Current Cycle", "当前周期"])) continue;
		sectionStart = index;
		sectionLevel = match[1]?.length ?? 0;
		break;
	}
	if (sectionStart === -1) {
		throw new Error('Task body has no "Current Cycle" section; normalize the task skeleton first.');
	}

	let insertAt = lines.length;
	for (let index = sectionStart + 1; index < lines.length; index++) {
		const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
		if (match && (match[1]?.length ?? 7) <= sectionLevel) {
			insertAt = index;
			break;
		}
	}

	while (insertAt > sectionStart + 1 && (lines[insertAt - 1] ?? "").trim() === "") {
		insertAt--;
	}
	lines.splice(insertAt, 0, `- ${trimmedNote}`);
	return lines.join("\n");
}

/**
 * Upsert the completion evidence subsection inside Current Cycle.
 *
 * Evidence is part of the cycle log, not a new top-level section. This makes the next
 * `startTaskCycle` fold it into the matching History entry and prevents repeated completion
 * attempts from appending duplicate evidence blocks.
 */
export function upsertCurrentCycleCompletionEvidence(content: string, evidenceLines: readonly string[]): string {
	const lines = content.split("\n");
	let currentStart = -1;
	let currentLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match || !matchesTaskSectionTitle(match[2] ?? "", ["Current Cycle", "当前周期"])) continue;
		currentStart = index;
		currentLevel = match[1]?.length ?? 0;
		break;
	}
	if (currentStart === -1 || currentLevel >= 6) {
		// Legacy/non-standard one-shot tasks were historically completable without the
		// canonical skeleton. Keep that compatibility, but upsert one bounded top-level
		// block instead of returning to the old append-only behavior.
		const stripped = stripLegacyCompletionEvidence(content).content.replace(/\n+$/, "");
		return `${stripped}\n\n## Completion Evidence\n\n${evidenceLines.join("\n")}\n`;
	}

	let currentEnd = lines.length;
	for (let index = currentStart + 1; index < lines.length; index++) {
		const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
		if (match && (match[1]?.length ?? 7) <= currentLevel) {
			currentEnd = index;
			break;
		}
	}

	const evidenceLevel = currentLevel + 1;
	let evidenceStart = -1;
	let evidenceEnd = -1;
	for (let index = currentStart + 1; index < currentEnd; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match) continue;
		const level = match[1]?.length ?? 7;
		if (level === evidenceLevel && matchesTaskSectionTitle(match[2] ?? "", ["Completion Evidence"])) {
			evidenceStart = index;
			evidenceEnd = currentEnd;
			for (let nested = index + 1; nested < currentEnd; nested++) {
				const nestedHeading = /^(#{1,6})\s+/.exec(lines[nested] ?? "");
				if (nestedHeading && (nestedHeading[1]?.length ?? 7) <= evidenceLevel) {
					evidenceEnd = nested;
					break;
				}
			}
			break;
		}
	}
	if (evidenceStart !== -1) {
		lines.splice(evidenceStart, evidenceEnd - evidenceStart);
		currentEnd -= evidenceEnd - evidenceStart;
	}

	while (currentEnd > currentStart + 1 && (lines[currentEnd - 1] ?? "").trim() === "") currentEnd--;
	const block = [`${"#".repeat(evidenceLevel)} Completion Evidence`, "", ...evidenceLines, ""];
	lines.splice(currentEnd, 0, ...block);
	return lines.join("\n");
}

function stripLegacyCompletionEvidence(content: string): {
	content: string;
	blocks: string[];
} {
	const lines = content.split("\n");
	const blocks: string[] = [];
	for (let index = 0; index < lines.length; ) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (
			!heading ||
			(heading[1]?.length ?? 0) !== 2 ||
			!matchesTaskSectionTitle(heading[2] ?? "", ["Completion Evidence"])
		) {
			index++;
			continue;
		}
		let end = lines.length;
		for (let nested = index + 1; nested < lines.length; nested++) {
			const nextHeading = /^(#{1,6})\s+/.exec(lines[nested] ?? "");
			if (nextHeading && (nextHeading[1]?.length ?? 7) <= 2) {
				end = nested;
				break;
			}
		}
		blocks.push(lines.slice(index, end).join("\n").trim());
		lines.splice(index, end - index);
		while (
			index > 0 &&
			index < lines.length &&
			(lines[index - 1] ?? "").trim() === "" &&
			(lines[index] ?? "").trim() === ""
		) {
			lines.splice(index, 1);
		}
	}
	return { content: lines.join("\n"), blocks };
}

function clipHistoryEntry(entry: string): string {
	if (entry.length <= MAX_INLINE_TASK_HISTORY_ENTRY_CHARS) return entry.trim();
	const suffix = `\n${HISTORY_TRUNCATION_NOTE}`;
	const limit = Math.max(0, MAX_INLINE_TASK_HISTORY_ENTRY_CHARS - suffix.length);
	let clipped = entry.slice(0, limit);
	const lastNewline = clipped.lastIndexOf("\n");
	if (lastNewline > 0) clipped = clipped.slice(0, lastNewline);
	return `${clipped.trimEnd()}${suffix}`;
}

function compactTaskHistory(content: string, alreadyOmitted = false): string {
	const lines = content.split("\n");
	let historyStart = -1;
	let historyLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (heading && matchesTaskSectionTitle(heading[2] ?? "", ["History", "历史"])) {
			historyStart = index;
			historyLevel = heading[1]?.length ?? 0;
			break;
		}
	}
	if (historyStart === -1 || historyLevel >= 6) return content;

	let historyEnd = lines.length;
	for (let index = historyStart + 1; index < lines.length; index++) {
		const heading = /^(#{1,6})\s+/.exec(lines[index] ?? "");
		if (heading && (heading[1]?.length ?? 7) <= historyLevel) {
			historyEnd = index;
			break;
		}
	}

	const entryStarts: number[] = [];
	for (let index = historyStart + 1; index < historyEnd; index++) {
		const heading = /^(#{1,6})\s+/.exec(lines[index] ?? "");
		if ((heading?.[1]?.length ?? 0) === historyLevel + 1) entryStarts.push(index);
	}
	if (entryStarts.length === 0) return content;

	const entries = entryStarts.map((start, index) =>
		clipHistoryEntry(
			lines
				.slice(start, entryStarts[index + 1] ?? historyEnd)
				.join("\n")
				.trim(),
		),
	);
	const kept: string[] = [];
	let chars = 0;
	for (const entry of entries) {
		const nextChars = chars + entry.length + (kept.length > 0 ? 2 : 0);
		if (kept.length >= MAX_INLINE_TASK_HISTORY_ENTRIES || nextChars > MAX_INLINE_TASK_HISTORY_CHARS) break;
		kept.push(entry);
		chars = nextChars;
	}
	const omitted = alreadyOmitted || kept.length < entries.length;
	const replacement = [
		"",
		...kept.flatMap((entry, index) => (index === kept.length - 1 ? [entry] : [entry, ""])),
		...(omitted ? ["", HISTORY_OMISSION_NOTE] : []),
		"",
	];
	lines.splice(historyStart + 1, historyEnd - historyStart - 1, ...replacement);
	return lines.join("\n");
}

/**
 * Close the visible current-cycle notes into History and open a fresh cycle.
 * Periodic task cycles deliberately use this small, deterministic transformation
 * instead of asking the model to hand-edit headings and risk appending future
 * checkpoints to the previous cycle.
 */
export function startTaskCycle(content: string, cycleId: string, archivePrevious = true): string {
	const normalizedCycleId = cycleId.trim();
	if (!normalizedCycleId) throw new Error("Cycle id must not be empty.");
	const legacy = stripLegacyCompletionEvidence(content);
	const lines = legacy.content.split("\n");
	let currentStart = -1;
	let currentLevel = 0;
	let historyStart = -1;
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match) continue;
		const level = match[1]?.length ?? 0;
		if (matchesTaskSectionTitle(match[2] ?? "", ["Current Cycle", "当前周期"])) {
			currentStart = index;
			currentLevel = level;
		}
		if (matchesTaskSectionTitle(match[2] ?? "", ["History", "历史"])) {
			historyStart = index;
			break;
		}
	}
	if (currentStart === -1 || historyStart === -1 || historyStart <= currentStart) {
		throw new Error('Task body needs ordered "Current Cycle" and "History" sections before starting a new cycle.');
	}

	let currentEnd = historyStart;
	for (let index = currentStart + 1; index < historyStart; index++) {
		const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
		if (match && (match[1]?.length ?? 7) <= currentLevel) {
			currentEnd = index;
			break;
		}
	}
	let previous = lines
		.slice(currentStart + 1, currentEnd)
		.join("\n")
		.trim();
	const latestLegacyEvidence = legacy.blocks.at(-1);
	if (latestLegacyEvidence && !/^(#{1,6})\s+Completion Evidence\b/im.test(previous)) {
		previous = `${previous}\n\n${latestLegacyEvidence.replace(/^##\s+/, "### ")}`.trim();
	}
	// The archived cycle gets its own H3 entry under History. Demote subsections that
	// were nested under the H2 Current Cycle so they remain children of that entry.
	previous = previous
		.split("\n")
		.map((line) => {
			const heading = /^(#{1,6})(\s+.*)$/.exec(line);
			const level = heading?.[1]?.length ?? 0;
			return heading && level > currentLevel && level < 6 ? `#${line}` : line;
		})
		.join("\n");
	const previousHeading = (lines[currentStart] ?? "## Current Cycle").replace(/^#+\s*/, "").trim();
	const replacement = [
		`${"#".repeat(currentLevel)} Current Cycle (${normalizedCycleId})`,
		"- Cycle started; next step: follow the Manual and checkpoint concrete progress.",
	];
	lines.splice(currentStart, currentEnd - currentStart, ...replacement);

	const shiftedHistoryStart = historyStart + replacement.length - (currentEnd - currentStart);
	if (archivePrevious && previous && !/^[-*]\s+Created; next step:/i.test(previous)) {
		const historyEntry = [`### ${previousHeading} — closed`, previous, ""];
		// A nested history heading would be unusual; inserting directly after the
		// canonical History heading remains predictable and preserves all older notes.
		lines.splice(shiftedHistoryStart + 1, 0, ...historyEntry);
	}
	const compacted = compactTaskHistory(lines.join("\n"), legacy.blocks.length > 1);
	return resetPlanStepCheckboxes(resetTaskAcceptanceCheckboxes(compacted));
}

/**
 * Uncheck every "- [x]" under DoD/Verification.
 *
 * `startTaskCycle` archives the previous cycle's log but never touched these boxes, so a
 * periodic task that finished cycle 1 with a fully checked DoD would open cycle 2 with
 * `uncheckedTaskAcceptanceItems` reporting zero unchecked items — the acceptance gate would
 * silently pass on stale evidence from a cycle that no longer exists.
 */
function resetTaskAcceptanceCheckboxes(content: string): string {
	const lines = content.split("\n");
	let section: "DoD" | "Verification" | undefined;
	let sectionLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			const level = heading[1]?.length ?? 7;
			if (matchesTaskSectionTitle(heading[2] ?? "", ["DoD"])) {
				section = "DoD";
				sectionLevel = level;
			} else if (matchesTaskSectionTitle(heading[2] ?? "", ["Verification", "验收"])) {
				section = "Verification";
				sectionLevel = level;
			} else if (section && level <= sectionLevel) {
				section = undefined;
			}
			continue;
		}
		if (!section) continue;
		const checkbox = /^(\s*[-*]\s+)\[[xX]\](\s*.*)$/.exec(line);
		if (checkbox) lines[index] = `${checkbox[1]}[ ]${checkbox[2]}`;
	}
	return lines.join("\n");
}

/**
 * Reset `## Plan` steps for a new cycle: `[x]` done and `[!]` blocked both go back to `[ ]`
 * todo, exactly like `resetTaskAcceptanceCheckboxes` — a stale "done" step from the previous
 * cycle must not silently pass as still true. `[~]` dropped is left alone: that step was
 * deliberately abandoned, not merely finished, and a new cycle should not resurrect it.
 */
function resetPlanStepCheckboxes(content: string): string {
	const lines = content.split("\n");
	let sectionStart = -1;
	let sectionLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match || !matchesTaskSectionTitle(match[2] ?? "", PLAN_SECTION_NAMES)) continue;
		sectionStart = index;
		sectionLevel = match[1]?.length ?? 0;
		break;
	}
	if (sectionStart === -1) return content;

	let sectionEnd = lines.length;
	for (let index = sectionStart + 1; index < lines.length; index++) {
		const match = /^(#{1,6})\s+/.exec(lines[index] ?? "");
		if (match && (match[1]?.length ?? 7) <= sectionLevel) {
			sectionEnd = index;
			break;
		}
	}

	for (let index = sectionStart + 1; index < sectionEnd; index++) {
		const checkbox = /^(\s*[-*]\s+)\[[xX!]\](\s*.*)$/.exec(lines[index] ?? "");
		if (checkbox) lines[index] = `${checkbox[1]}[ ]${checkbox[2]}`;
	}
	return lines.join("\n");
}

/** Last non-empty bullet/line under a "当前周期"/"current cycle" heading. */
function extractLatestNote(content: string): string | undefined {
	const lines = content.split("\n");
	let inSection = false;
	let sectionLevel = 0;
	let latest: string | undefined;
	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
		if (heading) {
			if (inSection && (heading[1]?.length ?? 7) <= sectionLevel) break;
			if (!inSection && matchesTaskSectionTitle(heading[2] ?? "", ["Current Cycle", "当前周期"])) {
				inSection = true;
				sectionLevel = heading[1]?.length ?? 0;
			}
			continue;
		}
		if (!inSection) continue;
		const trimmed = line.replace(/^\s*[-*]\s+/, "").trim();
		if (trimmed) latest = trimmed;
	}
	return latest;
}

function parseWakeMs(frontmatter: TaskFrontmatter): number | undefined {
	if (!frontmatter.wake) return undefined;
	return parseLocalTime(frontmatter.wake);
}

/** Actionable first; then earliest wake first (unset wake sorts as "ready now"); then id. */
export function compareTaskEntries(a: TaskLedgerEntry, b: TaskLedgerEntry): number {
	if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
	if (a.frontmatter.enabled !== b.frontmatter.enabled) return a.frontmatter.enabled ? -1 : 1;
	if (a.actionable && b.actionable) {
		const ap = taskPriorityRank(a.frontmatter.control?.priority ?? "normal");
		const bp = taskPriorityRank(b.frontmatter.control?.priority ?? "normal");
		if (ap !== bp) return ap - bp;
		const ad = a.frontmatter.control?.deadline
			? (parseLocalTime(a.frontmatter.control.deadline) ?? Number.POSITIVE_INFINITY)
			: Number.POSITIVE_INFINITY;
		const bd = b.frontmatter.control?.deadline
			? (parseLocalTime(b.frontmatter.control.deadline) ?? Number.POSITIVE_INFINITY)
			: Number.POSITIVE_INFINITY;
		if (ad !== bd) return ad - bd;
	}
	const aw = a.wakeMs ?? Number.NEGATIVE_INFINITY;
	const bw = b.wakeMs ?? Number.NEGATIVE_INFINITY;
	if (aw !== bw) return aw - bw;
	return a.id.localeCompare(b.id);
}

function toEntry(id: string, content: string, now: number): TaskLedgerEntry {
	const frontmatter = parseTaskFrontmatter(content);
	return {
		id,
		title: extractTaskTitle(content, id),
		frontmatter,
		actionable: isTaskActionable(frontmatter, now),
		wakeMs: parseWakeMs(frontmatter),
		latestNote: extractLatestNote(content),
		plan: parseTaskPlan(content),
	};
}

/**
 * Parsed task files, keyed by path and invalidated by (mtime, ctime, size) — the same
 * fingerprint the memory candidate store uses.
 *
 * The task driver re-reads every channel's whole ledger on every tick *and* after every turn
 * (`nudge`), so an unchanged file was being read and re-parsed (frontmatter + control JSON +
 * body scan) many times per minute. Only `actionable` depends on the clock, so it is recomputed
 * from `now` on every call and never cached.
 *
 * Cached entries are handed out by reference, which is safe because every consumer of
 * `readActiveTasks` only reads: the read-modify-write path goes through `readStoredTask`, which
 * always reads the file itself. Treat entries from here as immutable.
 */
interface CachedTaskParse {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	entry: Omit<TaskLedgerEntry, "actionable">;
}

const parseCache = new Map<string, CachedTaskParse>();
/** Bound the cache for a long-lived daemon: far above any real ledger, and cheap to refill. */
const PARSE_CACHE_LIMIT = 512;

async function readEntry(path: string, id: string, now: number): Promise<TaskLedgerEntry> {
	const stats = await stat(path);
	const cached = parseCache.get(path);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.ctimeMs === stats.ctimeMs && cached.size === stats.size) {
		return { ...cached.entry, actionable: isTaskActionable(cached.entry.frontmatter, now) };
	}
	const entry = toEntry(id, await readFile(path, "utf-8"), now);
	if (parseCache.size >= PARSE_CACHE_LIMIT) parseCache.clear();
	parseCache.set(path, { mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size, entry });
	return entry;
}

/**
 * Read every `.md` file in `tasks/` (root only — the `archive/` subdirectory is not
 * scanned), returning entries sorted actionable-first. A file that cannot be read is
 * still returned (fail-open: `readable: false`, `actionable: true`) so problems surface.
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
				frontmatter: { readable: false, enabled: true },
				actionable: true,
			});
		}
	}

	entries.sort(compareTaskEntries);
	return entries;
}
