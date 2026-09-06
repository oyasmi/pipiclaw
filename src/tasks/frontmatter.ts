import { formatLocalTime } from "../shared/local-time.js";
import { isPlainObject } from "../shared/type-guards.js";
import { parseTicket, type Ticket } from "./ticket.js";

/**
 * The v4 task frontmatter (spec 051, §12.2).
 *
 * v3 spread one question across pairs of fields that had to agree — `enabled: false` had to match
 * `control.stop`, `status: active` had to not carry a future `wake` — and `/tasks doctor` existed
 * largely to find the pairs that had drifted. v4 removes the pairs instead of diagnosing them:
 * `paused` present *is* paused, and `state: "parked"` ⟺ `ticket` present (INV-1), enforced on
 * every read and every write rather than checked after the fact.
 */
export type TaskState = "open" | "parked" | "done";

export interface TaskPaused {
	by: "user" | "runtime";
	reason: string;
	at: string;
}

/** Live counters for the cycle in flight. Reset by `openCycle`, read by the budget and `/tasks`. */
export interface TaskCycle {
	id: string;
	startedAt: string;
	steps: number;
	rounds: number;
	usd: number;
	/** True once any cost in this cycle came from an estimate rather than reported usage (D10). */
	usdEstimated: boolean;
	/** Ticket backstops that expired in this cycle; the second one notifies the user (D2). */
	expired: number;
}

export interface TaskBudget {
	steps: number;
	wallMin: number;
	usd: number;
	rounds: number;
	/** Absolute local-time stop, the v4 home of v3's `control.deadline`. */
	until?: string;
}

export type TaskArchiveOutcome = "completed" | "cancelled";

export interface TaskFrontmatterV4 {
	state: TaskState;
	paused?: TaskPaused;
	schedule?: string;
	/** Present iff `state === "parked"` (INV-1). */
	ticket?: Ticket;
	cycle?: TaskCycle;
	budget?: Partial<TaskBudget>;
	verify?: "required";
	/** Archive-only. */
	outcome?: TaskArchiveOutcome;
	closedAt?: string;
}

export interface ParsedTaskFrontmatter {
	fields: TaskFrontmatterV4;
	/** false => the block could not be read at all; the task is surfaced rather than skipped. */
	readable: boolean;
	/** True when a v3 `control:`/`status:` line is present — the migrator's only trigger. */
	legacy: boolean;
}

const STATES: readonly TaskState[] = ["open", "parked", "done"];
/** Fixed render order, so a diff of a task file reads the same way every time. */
const FIELD_ORDER = ["state", "paused", "schedule", "ticket", "cycle", "budget", "verify"] as const;

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

function parseCycle(raw: string): TaskCycle | undefined {
	const value = parseJsonObject(raw);
	if (!value || typeof value.id !== "string" || !value.id.trim()) return undefined;
	return {
		id: value.id.trim(),
		startedAt: typeof value.startedAt === "string" && value.startedAt ? value.startedAt : formatLocalTime(),
		steps: nonNegativeNumber(value.steps, 0),
		rounds: nonNegativeNumber(value.rounds, 0),
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
	if (typeof value.wallMin === "number" && value.wallMin > 0) budget.wallMin = value.wallMin;
	if (typeof value.usd === "number" && value.usd > 0) budget.usd = value.usd;
	if (typeof value.rounds === "number" && value.rounds > 0) budget.rounds = value.rounds;
	if (typeof value.until === "string" && value.until.trim()) budget.until = value.until.trim();
	return Object.keys(budget).length > 0 ? budget : undefined;
}

/**
 * Read the leading frontmatter block. Unreadable input fails **open** to a live `open` task: a
 * corrupt file has to surface as work the runtime tries to touch, not silently disappear from the
 * ledger — the same fail-open stance v3 took, for the same reason.
 */
export function parseTaskFrontmatterV4(content: string): ParsedTaskFrontmatter {
	if (!content.startsWith("---")) return { fields: { state: "open" }, readable: false, legacy: false };
	const end = content.indexOf("\n---", 3);
	if (end === -1) return { fields: { state: "open" }, readable: false, legacy: false };

	const fields: TaskFrontmatterV4 = { state: "open" };
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
			case "schedule":
				fields.schedule = value || undefined;
				break;
			case "ticket":
				fields.ticket = parseTicket(value);
				break;
			case "cycle":
				fields.cycle = parseCycle(value);
				break;
			case "budget":
				fields.budget = parseBudget(value);
				break;
			case "verify":
				if (value === "required") fields.verify = "required";
				break;
			case "outcome":
				if (value === "completed" || value === "cancelled") fields.outcome = value;
				break;
			case "closedAt":
				fields.closedAt = value || undefined;
				break;
			// v3 leftovers: their presence is the migrator's trigger, their values are its input.
			case "status":
			case "enabled":
			case "control":
			case "wake":
				legacy = true;
				break;
			default:
				break;
		}
	}
	if (fields.outcome) fields.state = "done";
	// A file with no recognizable v4 or v3 marker is not frontmatter we understand.
	const readable = sawState || fields.outcome !== undefined || legacy;
	return { fields: normalizeTaskFrontmatter(fields), readable, legacy };
}

/**
 * Enforce INV-1 on every write and read: `parked` requires a ticket, and a ticket only means
 * anything while parked. Doing it here rather than at each call site is what makes "a parked task
 * always has a redeemable, backstopped source" a property of the file format instead of a rule
 * every writer has to remember.
 */
export function normalizeTaskFrontmatter(fields: TaskFrontmatterV4): TaskFrontmatterV4 {
	const next: TaskFrontmatterV4 = { ...fields };
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

export function renderTaskFrontmatter(fields: TaskFrontmatterV4): string {
	const document = normalizeTaskFrontmatter(fields);
	const lines: string[] = ["---"];
	if (document.outcome) {
		lines.push(`outcome: ${document.outcome}`);
		if (document.closedAt) lines.push(`closedAt: ${document.closedAt}`);
		if (document.cycle) lines.push(`cycle: ${JSON.stringify(document.cycle)}`);
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
export function isTaskRunnable(fields: TaskFrontmatterV4): boolean {
	return fields.state === "open" && !fields.paused && !fields.outcome;
}
