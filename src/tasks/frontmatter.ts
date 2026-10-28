import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { isPlainObject } from "../shared/type-guards.js";

/**
 * The task frontmatter (spec 064, D2).
 *
 * A task is a one-off project: it is queued, runs, waits and is finally archived. Every field
 * except the contract body belongs to the runtime — the lane and `tasks/store.ts` write them from
 * observed facts, and no model tool can (INV-2). `state: waiting` ⟺ `waiting` present and
 * `state: paused` ⟺ `paused` present (INV-3) are enforced on every read and every write rather
 * than checked after the fact. An archived file carries `outcome` instead of a state.
 */
export type TaskState = "queued" | "running" | "waiting" | "paused";

/** What a waiting task is waiting for — derived from facts, never declared by the model. */
export type TaskWaiting =
	| { kind: "work"; since: string }
	| { kind: "user"; question: string; since: string }
	| { kind: "time"; until: string; since: string };

export interface TaskPaused {
	by: "user" | "runtime";
	reason: string;
	at: string;
}

/** Live counters for the whole task. Read by the budget and `/tasks`. */
export interface TaskUsage {
	startedAt: string;
	steps: number;
	usd: number;
	/** True once any cost came from an estimate rather than reported usage. */
	usdEstimated: boolean;
}

export interface TaskBudget {
	steps: number;
	usd: number;
}

export type TaskArchiveOutcome = "completed" | "cancelled";

export interface TaskFrontmatter {
	/** Meaningless once `outcome` is set: an archived task has no state. */
	state: TaskState;
	/** Present iff `state === "waiting"` (INV-3). */
	waiting?: TaskWaiting;
	/** Present iff `state === "paused"` (INV-3). */
	paused?: TaskPaused;
	/**
	 * The delivery channel: where every report, question and receipt of this task goes (spec 058,
	 * D13). Plain text so a human can retarget it by hand. Missing, or not bound to this task's
	 * desk, means the task is frozen until the channel is bound again (INV-7).
	 */
	channel?: string;
	/** Name of the event whose template spawned this instance (spec 052, D2). */
	origin?: string;
	usage?: TaskUsage;
	budget?: Partial<TaskBudget>;
	/** Archive-only. */
	outcome?: TaskArchiveOutcome;
	closedAt?: string;
}

export interface ParsedTaskFrontmatter {
	fields: TaskFrontmatter;
	/** false => the block could not be read at all; the task is surfaced rather than skipped. */
	readable: boolean;
}

const STATES: readonly TaskState[] = ["queued", "running", "waiting", "paused"];

/** Fixed render order, so a diff of a task file reads the same way every time. */
const FIELD_ORDER = ["state", "waiting", "paused", "channel", "origin", "usage", "budget"] as const;

/** `2026-10-12T09:00:00.000+08:00` → `10-12 09:00`, read off the stored wall-clock text. */
function minuteOf(at: string): string {
	const match = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(at);
	return match ? `${match[1]} ${match[2]}` : at;
}

/**
 * The one user-facing name for a task's state (spec 053, D8; spec 064, D6). `/tasks`, the task
 * agenda and the spawn-skip receipt all read it here, so a third hand-written copy cannot drift.
 */
export function taskStateLabel(fields: Pick<TaskFrontmatter, "state" | "waiting">): string {
	switch (fields.state) {
		case "queued":
			return "排队中";
		case "running":
			return "执行中";
		case "paused":
			return "已暂停";
		case "waiting": {
			const waiting = fields.waiting;
			if (waiting?.kind === "user") return "等你回复";
			if (waiting?.kind === "time") return `等到 ${minuteOf(waiting.until)}`;
			return "等结果";
		}
	}
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		return isPlainObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseWaiting(raw: string): TaskWaiting | undefined {
	const value = parseJsonObject(raw);
	if (!value) return undefined;
	const since = nonEmptyString(value.since) ?? formatLocalTime();
	switch (value.kind) {
		case "work":
			return { kind: "work", since };
		case "user": {
			const question = nonEmptyString(value.question);
			return question ? { kind: "user", question, since } : undefined;
		}
		case "time": {
			const until = nonEmptyString(value.until);
			return until && parseLocalTime(until) !== undefined ? { kind: "time", until, since } : undefined;
		}
		default:
			return undefined;
	}
}

function parsePaused(raw: string): TaskPaused | undefined {
	const value = parseJsonObject(raw);
	if (!value) return undefined;
	const by = value.by === "runtime" ? "runtime" : "user";
	const reason = nonEmptyString(value.reason);
	if (!reason) return undefined;
	return { by, reason, at: nonEmptyString(value.at) ?? formatLocalTime() };
}

function nonNegativeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseUsage(raw: string): TaskUsage | undefined {
	const value = parseJsonObject(raw);
	if (!value) return undefined;
	return {
		startedAt: nonEmptyString(value.startedAt) ?? formatLocalTime(),
		steps: nonNegativeNumber(value.steps, 0),
		usd: nonNegativeNumber(value.usd, 0),
		usdEstimated: value.usdEstimated === true,
	};
}

function parseBudget(raw: string): Partial<TaskBudget> | undefined {
	const value = parseJsonObject(raw);
	if (!value) return undefined;
	const budget: Partial<TaskBudget> = {};
	if (typeof value.steps === "number" && value.steps > 0) budget.steps = value.steps;
	if (typeof value.usd === "number" && value.usd > 0) budget.usd = value.usd;
	return Object.keys(budget).length > 0 ? budget : undefined;
}

/**
 * Read the leading frontmatter block. Unreadable input fails **open**: the task still appears in
 * the ledger (as `queued`, flagged unreadable) so a corrupt file surfaces instead of vanishing; the
 * lane will not execute it (`/tasks doctor` points at the repair).
 */
export function parseTaskFrontmatter(content: string): ParsedTaskFrontmatter {
	if (!content.startsWith("---")) return { fields: { state: "queued" }, readable: false };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { fields: { state: "queued" }, readable: false };

	const fields: TaskFrontmatter = { state: "queued" };
	let sawState = false;
	for (const line of content.slice(3, end).split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		switch (key) {
			case "state":
				if ((STATES as readonly string[]).includes(value)) {
					fields.state = value as TaskState;
					sawState = true;
				}
				break;
			case "waiting":
				fields.waiting = parseWaiting(value);
				break;
			case "paused":
				fields.paused = parsePaused(value);
				break;
			case "usage":
				fields.usage = parseUsage(value);
				break;
			case "budget":
				fields.budget = parseBudget(value);
				break;
			case "origin":
				fields.origin = value || undefined;
				break;
			case "channel":
				fields.channel = value || undefined;
				break;
			case "outcome":
				if (value === "completed" || value === "cancelled") fields.outcome = value;
				break;
			case "closedAt":
				fields.closedAt = value || undefined;
				break;
			default:
				break;
		}
	}
	// A file with no recognizable marker is not frontmatter we understand.
	const readable = sawState || fields.outcome !== undefined;
	return { fields: normalizeTaskFrontmatter(fields), readable };
}

/**
 * Enforce INV-3 on every write and read: `waiting` and `paused` states need their field, and the
 * fields mean nothing outside their state. Doing it here rather than at each call site is what
 * makes "waiting with nothing described" a property of the file format instead of a rule every
 * writer has to remember.
 */
export function normalizeTaskFrontmatter(fields: TaskFrontmatter): TaskFrontmatter {
	const next: TaskFrontmatter = { ...fields };
	if (next.outcome) {
		next.waiting = undefined;
		next.paused = undefined;
		return next;
	}
	if (next.state === "waiting" && !next.waiting) next.state = "queued";
	if (next.state === "paused" && !next.paused) next.state = "queued";
	if (next.state !== "waiting") next.waiting = undefined;
	if (next.state !== "paused") next.paused = undefined;
	return next;
}

export function renderTaskFrontmatter(fields: TaskFrontmatter): string {
	const document = normalizeTaskFrontmatter(fields);
	const lines: string[] = ["---"];
	if (document.outcome) {
		lines.push(`outcome: ${document.outcome}`);
		if (document.closedAt) lines.push(`closedAt: ${document.closedAt}`);
		if (document.channel) lines.push(`channel: ${document.channel}`);
		if (document.origin) lines.push(`origin: ${document.origin}`);
		if (document.usage) lines.push(`usage: ${JSON.stringify(document.usage)}`);
		lines.push("---");
		return lines.join("\n");
	}
	for (const key of FIELD_ORDER) {
		const value = document[key];
		if (value === undefined) continue;
		lines.push(typeof value === "string" ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`);
	}
	lines.push("---");
	return lines.join("\n");
}
