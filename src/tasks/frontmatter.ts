import { formatLocalTime } from "../shared/local-time.js";
import { isPlainObject } from "../shared/type-guards.js";
import { parseTicket, type Ticket } from "./ticket.js";

/**
 * The task frontmatter (spec 052, §3.3).
 *
 * A task is a one-off project: it opens, is worked until `done` or cancelled, and is archived.
 * Recurring work is an event that spawns a fresh instance each time (spec 052, D2), so there is
 * no cadence, no cycle and no verification flag here. `state: "parked"` ⟺ `ticket` present
 * (INV-1) is enforced on every read and every write rather than checked after the fact.
 */
export type TaskState = "open" | "parked" | "done";

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
	/** Consecutive ticket backstops that expired; the second one stops the task (D3). */
	expired: number;
}

export interface TaskBudget {
	steps: number;
	usd: number;
}

export type TaskArchiveOutcome = "completed" | "cancelled";

export interface TaskFrontmatter {
	state: TaskState;
	paused?: TaskPaused;
	/** Present iff `state === "parked"` (INV-1). */
	ticket?: Ticket;
	usage?: TaskUsage;
	budget?: Partial<TaskBudget>;
	/** Name of the event whose template spawned this instance (spec 052, D2). */
	origin?: string;
	/** Archive-only. */
	outcome?: TaskArchiveOutcome;
	closedAt?: string;
}

export interface ParsedTaskFrontmatter {
	fields: TaskFrontmatter;
	/** false => the block could not be read at all; the task is surfaced rather than skipped. */
	readable: boolean;
	/** True when a v3/v4 line (`status`, `control`, `cycle`, `schedule`, `verify`…) is present — `/tasks doctor`'s only trigger. */
	legacy: boolean;
}

const STATES: readonly TaskState[] = ["open", "parked", "done"];
/** Fixed render order, so a diff of a task file reads the same way every time. */
const FIELD_ORDER = ["state", "paused", "origin", "ticket", "usage", "budget"] as const;
/** Frontmatter keys older versions wrote; their presence means the one-time conversion has not run on this file. */
const LEGACY_KEYS = new Set(["status", "enabled", "control", "wake", "cycle", "schedule", "verify"]);

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		return isPlainObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function parsePaused(raw: string): TaskPaused | undefined {
	const value = parseJsonObject(raw);
	if (!value) return undefined;
	const by = value.by === "runtime" ? "runtime" : "user";
	const reason = typeof value.reason === "string" ? value.reason.trim() : "";
	const at = typeof value.at === "string" ? value.at.trim() : "";
	if (!reason) return undefined;
	return { by, reason, at: at || formatLocalTime() };
}

function nonNegativeNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseUsage(raw: string): TaskUsage | undefined {
	const value = parseJsonObject(raw);
	if (!value) return undefined;
	return {
		startedAt: typeof value.startedAt === "string" && value.startedAt ? value.startedAt : formatLocalTime(),
		steps: nonNegativeNumber(value.steps, 0),
		usd: nonNegativeNumber(value.usd, 0),
		usdEstimated: value.usdEstimated === true,
		expired: nonNegativeNumber(value.expired, 0),
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
 * Read the leading frontmatter block. Unreadable input fails **open** to a live `open` task: a
 * corrupt file has to surface as work the runtime tries to touch, not silently disappear from the
 * ledger.
 */
export function parseTaskFrontmatter(content: string): ParsedTaskFrontmatter {
	if (!content.startsWith("---")) return { fields: { state: "open" }, readable: false, legacy: false };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { fields: { state: "open" }, readable: false, legacy: false };

	const fields: TaskFrontmatter = { state: "open" };
	let legacy = false;
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
			case "paused":
				fields.paused = parsePaused(value);
				break;
			case "ticket":
				fields.ticket = parseTicket(value);
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
			case "outcome":
				if (value === "completed" || value === "cancelled") fields.outcome = value;
				break;
			case "closedAt":
				fields.closedAt = value || undefined;
				break;
			default:
				if (LEGACY_KEYS.has(key)) legacy = true;
				break;
		}
	}
	if (fields.outcome) fields.state = "done";
	// A file with no recognizable marker is not frontmatter we understand.
	const readable = sawState || fields.outcome !== undefined || legacy;
	return { fields: normalizeTaskFrontmatter(fields), readable, legacy };
}

/**
 * Enforce INV-1 on every write and read: `parked` requires a ticket, and a ticket only means
 * anything while parked. Doing it here rather than at each call site is what makes "a parked task
 * always has a redeemable, backstopped source" a property of the file format instead of a rule
 * every writer has to remember.
 */
export function normalizeTaskFrontmatter(fields: TaskFrontmatter): TaskFrontmatter {
	const next: TaskFrontmatter = { ...fields };
	if (next.outcome) {
		next.state = "done";
		next.ticket = undefined;
		next.paused = undefined;
		return next;
	}
	if (next.state === "parked" && !next.ticket) next.state = "open";
	if (next.state !== "parked") next.ticket = undefined;
	return next;
}

export function renderTaskFrontmatter(fields: TaskFrontmatter): string {
	const document = normalizeTaskFrontmatter(fields);
	const lines: string[] = ["---"];
	if (document.outcome) {
		lines.push(`outcome: ${document.outcome}`);
		if (document.closedAt) lines.push(`closedAt: ${document.closedAt}`);
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

/** Whether the driver may schedule a step for this task right now. */
export function isTaskRunnable(fields: TaskFrontmatter): boolean {
	return fields.state === "open" && !fields.paused && !fields.outcome;
}
