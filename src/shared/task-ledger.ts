import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
	recurrence?: string;
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

const FRONTMATTER_FIELDS = ["status", "wake", "recurrence"] as const;
const TASK_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

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
			frontmatter[key as (typeof FRONTMATTER_FIELDS)[number]] = value || undefined;
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
	if (frontmatter.status === "done") return false;
	if (frontmatter.wake) {
		const wakeAt = new Date(frontmatter.wake).getTime();
		if (Number.isFinite(wakeAt) && wakeAt > now) return false;
	}
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

/** First non-empty bullet/line under a "当前周期"/"current cycle" heading. */
function extractLatestNote(content: string): string | undefined {
	const lines = content.split("\n");
	let inSection = false;
	for (const line of lines) {
		if (/^#{1,6}\s/.test(line)) {
			inSection = /当前周期|current cycle/i.test(line);
			continue;
		}
		if (!inSection) continue;
		const trimmed = line.replace(/^\s*[-*]\s+/, "").trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

function wakeMsOf(frontmatter: TaskFrontmatter): number | undefined {
	if (!frontmatter.wake) return undefined;
	const at = new Date(frontmatter.wake).getTime();
	return Number.isFinite(at) ? at : undefined;
}

/** Actionable first; then earliest wake first (unset wake sorts as "ready now"); then id. */
export function compareTaskEntries(a: TaskLedgerEntry, b: TaskLedgerEntry): number {
	if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
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
		wakeMs: wakeMsOf(frontmatter),
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
