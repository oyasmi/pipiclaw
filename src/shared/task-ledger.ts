import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseTaskControl, type TaskControl, type TaskVerificationMode, taskPriorityRank } from "../tasks/control.js";

/**
 * Shared reader for the task ledger (`workspace/<channelId>/tasks/*.md`).
 *
 * This is the in-repo half of the frontmatter contract documented in `docs/tasks.md`
 * ("Frontmatter 契约（单一事实源）"). The heartbeat sensor `tasks-pending.mjs` is the
 * out-of-repo half (a dependency-free script in workspace/skills). Both MUST agree on
 * `actionable`, so the parsing here is a deliberate, literal mirror of that script:
 * three flat `key: value` fields, done-vs-not-done, wake gating, fail-open on unreadable
 * frontmatter. `/tasks`, the task digest, and `task_manage list` all read through here.
 */

export interface TaskFrontmatter {
	/** false => frontmatter could not be read (fail-open: the task is treated as actionable). */
	readable: boolean;
	status?: string;
	wake?: string;
	/** Five-field cron cadence (host timezone). Present ⇒ this is a recurring task. */
	schedule?: string;
	recurrence?: string;
	control?: TaskControl;
	/** false only when a control field exists but cannot be parsed/validated. */
	controlReadable?: boolean;
}

export interface TaskLedgerEntry {
	/** Filename without `.md`; the task id. */
	id: string;
	/** First `# ` heading in the body, or the id when none. */
	title: string;
	frontmatter: TaskFrontmatter;
	/** status ≠ done AND (no valid wake OR wake ≤ now). Matches the sensor exactly. */
	actionable: boolean;
	/** Milliseconds since epoch parsed from `wake`, or undefined when unset/unparseable. */
	wakeMs?: number;
	/** First bullet/line under a "当前周期"/"current cycle" heading, if any (digest only). */
	latestNote?: string;
}

export interface TaskSkeletonInput {
	title: string;
	goal: string;
	dod: string;
	manual?: string;
	verificationPlan?: string;
	verificationMode?: TaskVerificationMode;
}

const FRONTMATTER_FIELDS = ["status", "wake", "schedule", "recurrence", "control"] as const;
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

/** Parse the leading `---` frontmatter block into the three known fields. */
export function parseTaskFrontmatter(content: string): TaskFrontmatter {
	if (!content.startsWith("---")) return { readable: false };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { readable: false };

	const block = content.slice(3, end);
	const frontmatter: TaskFrontmatter = { readable: true };
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
						frontmatter.control = parseTaskControl(value);
						frontmatter.controlReadable = true;
					} catch {
						frontmatter.controlReadable = false;
					}
				}
			} else {
				frontmatter[key as "status" | "wake" | "schedule" | "recurrence"] = value || undefined;
			}
		}
	}
	return frontmatter;
}

/**
 * The single shared judgement: is there work to do on this task right now?
 * Unreadable frontmatter is fail-open (actionable) so a corrupt ledger surfaces
 * rather than being silently skipped — identical to the sensor's behaviour.
 */
export function isTaskActionable(frontmatter: TaskFrontmatter, now: number): boolean {
	if (!frontmatter.readable) return true;
	if (frontmatter.controlReadable === false) return true;
	if (
		frontmatter.status === "done" ||
		frontmatter.status === "cancelled" ||
		frontmatter.status === "escalated" ||
		frontmatter.status === "paused"
	) {
		return false;
	}
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
 * `task_manage candidate`/`done` through with nothing ever actually verified.
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
			'DoD has no checklist items — rewrite it as "- [ ] ..." acceptance items before requesting verification or done.',
		);
	}
	return unchecked;
}

export function renderStandardTaskBody(input: TaskSkeletonInput): string {
	const manual = input.manual?.trim() || DEFAULT_TASK_MANUAL;
	const verificationPlan =
		input.verificationPlan?.trim() ||
		"- Check every DoD item against concrete evidence.\n- Run the relevant deterministic checks before declaring PASS.";
	const verificationMode = input.verificationMode ?? "independent";
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
		`Mode: ${verificationMode}`,
		verificationPlan,
		"",
		"## Current Cycle",
		"- Created; next step: start work and append progress here before ending each turn.",
		"",
		"## History",
		"",
	].join("\n");
}

export interface TaskDocumentFields {
	status: string;
	wake?: string;
	schedule?: string;
	recurrence?: string;
	control?: TaskControl;
}

export function renderTaskDocument(fields: TaskDocumentFields, body: string): string {
	const lines = ["---", `status: ${fields.status}`];
	if (fields.wake) lines.push(`wake: ${fields.wake}`);
	if (fields.schedule) lines.push(`schedule: ${fields.schedule}`);
	if (fields.recurrence) lines.push(`recurrence: ${fields.recurrence}`);
	if (fields.control) lines.push(`control: ${JSON.stringify(fields.control)}`);
	lines.push("---");
	return `${lines.join("\n")}\n${body}`;
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
 * Close the visible current-cycle notes into History and open a fresh cycle.
 * Periodic task cycles deliberately use this small, deterministic transformation
 * instead of asking the model to hand-edit headings and risk appending future
 * checkpoints to the previous cycle.
 */
export function startTaskCycle(content: string, cycleId: string): string {
	const normalizedCycleId = cycleId.trim();
	if (!normalizedCycleId) throw new Error("Cycle id must not be empty.");
	const lines = content.split("\n");
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
	const previous = lines
		.slice(currentStart + 1, currentEnd)
		.join("\n")
		.trim();
	const previousHeading = (lines[currentStart] ?? "## Current Cycle").replace(/^#+\s*/, "").trim();
	const replacement = [
		`${"#".repeat(currentLevel)} Current Cycle (${normalizedCycleId})`,
		"- Cycle started; next step: follow the Manual and checkpoint concrete progress.",
	];
	lines.splice(currentStart, currentEnd - currentStart, ...replacement);

	const shiftedHistoryStart = historyStart + replacement.length - (currentEnd - currentStart);
	const historyEntry = [
		`### ${previousHeading} — closed`,
		...(previous ? [previous] : ["- No checkpoint was recorded in the previous cycle."]),
		"",
	];
	// A nested history heading would be unusual; inserting directly after the
	// canonical History heading remains predictable and preserves all older notes.
	lines.splice(shiftedHistoryStart + 1, 0, ...historyEntry);
	return resetTaskAcceptanceCheckboxes(lines.join("\n"));
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
	const at = new Date(frontmatter.wake).getTime();
	return Number.isFinite(at) ? at : undefined;
}

/** Actionable first; then earliest wake first (unset wake sorts as "ready now"); then id. */
export function compareTaskEntries(a: TaskLedgerEntry, b: TaskLedgerEntry): number {
	if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
	if (a.actionable && b.actionable) {
		const ap = taskPriorityRank(a.frontmatter.control?.priority ?? "normal");
		const bp = taskPriorityRank(b.frontmatter.control?.priority ?? "normal");
		if (ap !== bp) return ap - bp;
		const ad = a.frontmatter.control?.deadline
			? new Date(a.frontmatter.control.deadline).getTime()
			: Number.POSITIVE_INFINITY;
		const bd = b.frontmatter.control?.deadline
			? new Date(b.frontmatter.control.deadline).getTime()
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
	};
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
		try {
			const content = await readFile(join(tasksDir, dirent.name), "utf-8");
			entries.push(toEntry(id, content, now));
		} catch {
			entries.push({
				id,
				title: id,
				frontmatter: { readable: false },
				actionable: true,
			});
		}
	}

	entries.sort(compareTaskEntries);
	return entries;
}
