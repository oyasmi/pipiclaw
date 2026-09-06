import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import { formatLocalTime } from "../shared/local-time.js";
import { clipText } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { normalizeTaskId } from "./ledger.js";

/**
 * The task's append-only loop log (spec 051, D5) — `tasks/<id>.jsonl`.
 *
 * v3 kept this history inline in the task file under `## History`, capped at 24 KB / 8 entries.
 * Both long-lived tasks on the author's machine sat permanently *at* that cap: 79% of a 30 KB
 * task file was closed cycles the model re-read on every single wake and never acted on. Moving
 * it here keeps the contract small enough to inject whole (INV-6) while making the history
 * *longer*, not shorter — nothing is folded away any more.
 *
 * The log is append-only and is never rewritten; the contract's `## 上次结果` is a projection of
 * its latest `close`, not a replacement for it.
 */
export type TaskStepOutcome = "continue" | "park" | "done" | "blocked";

export interface TaskStepRecord {
	ts: string;
	cycle: string;
	kind: "step";
	seq: number;
	outcome: TaskStepOutcome;
	note: string;
	tools: string[];
	usd?: number;
	usdEstimated?: boolean;
	units?: number;
}

export interface TaskRoundRecord {
	ts: string;
	cycle: string;
	kind: "round";
	n: number;
	workRunId?: string;
	verifyRunId: string;
	verdict: "pass" | "fail";
	strength: "enforced" | "advisory";
	/** Why an attested PASS was downgraded to a fail; absent when the attestation held. */
	reason?: string;
}

export interface TaskExpiredRecord {
	ts: string;
	cycle: string;
	kind: "expired";
	ticket: string;
	action: "reopened" | "paused";
}

export interface TaskCloseRecord {
	ts: string;
	cycle: string;
	kind: "close";
	outcome: "done" | "cancelled";
	summary: string;
	evidence?: string;
	residualRisk?: string;
	steps: number;
	rounds: number;
	usd: number;
}

export type TaskLogRecord = TaskStepRecord | TaskRoundRecord | TaskExpiredRecord | TaskCloseRecord;

/** Same rotation shape as the channel archive: the log is working history, not an audit trail. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const NOTE_MAX_CHARS = 4_000;

export function taskLogPath(channelDir: string, id: string): string {
	return join(channelDir, "tasks", `${normalizeTaskId(id)}.jsonl`);
}

const appenders = new Map<string, JsonlAppender>();

function appenderFor(path: string): JsonlAppender {
	const existing = appenders.get(path);
	if (existing) return existing;
	const appender = createJsonlAppender({ path, maxSizeBytes: MAX_LOG_BYTES, maxRotations: 2 });
	appenders.set(path, appender);
	return appender;
}

/** Test seam: drop cached appenders so a temp-dir fixture does not leak into the next case. */
export async function resetTaskLogAppenders(): Promise<void> {
	const open = [...appenders.values()];
	appenders.clear();
	await Promise.all(open.map((appender) => appender.close()));
}

export type TaskLogInput =
	| (Omit<TaskStepRecord, "ts"> & { ts?: string })
	| (Omit<TaskRoundRecord, "ts"> & { ts?: string })
	| (Omit<TaskExpiredRecord, "ts"> & { ts?: string })
	| (Omit<TaskCloseRecord, "ts"> & { ts?: string });

/**
 * Append one record. `appendStrict` rather than `append`: the loop log is the only durable trace
 * of what a step did, so a dropped record would make the next brief lie about the task's history.
 */
export async function appendTaskLog(channelDir: string, id: string, record: TaskLogInput): Promise<void> {
	const withTs = { ts: record.ts ?? formatLocalTime(), ...record };
	if (withTs.kind === "step") withTs.note = clipText(withTs.note, NOTE_MAX_CHARS);
	await appenderFor(taskLogPath(channelDir, id)).appendStrict(withTs);
}

function toRecord(value: unknown): TaskLogRecord | undefined {
	if (!isPlainObject(value) || typeof value.ts !== "string" || typeof value.cycle !== "string") return undefined;
	const kind = value.kind;
	if (kind !== "step" && kind !== "round" && kind !== "expired" && kind !== "close") return undefined;
	return value as unknown as TaskLogRecord;
}

export interface ReadTaskLogOptions {
	/** Only records from this cycle. */
	cycle?: string;
	/** Keep at most this many, counted from the end (the most recent). */
	limit?: number;
	kinds?: readonly TaskLogRecord["kind"][];
}

/**
 * Read the log back, newest-last. Unparseable lines are skipped rather than failing the read: a
 * hand-edited or half-written line must not make a task's whole history unreadable.
 */
export async function readTaskLog(
	channelDir: string,
	id: string,
	options: ReadTaskLogOptions = {},
): Promise<TaskLogRecord[]> {
	const path = taskLogPath(channelDir, id);
	if (!existsSync(path)) return [];
	let content: string;
	try {
		content = await readFile(path, "utf-8");
	} catch {
		return [];
	}
	const records: TaskLogRecord[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const record = toRecord(parsed);
		if (!record) continue;
		if (options.cycle && record.cycle !== options.cycle) continue;
		if (options.kinds && !options.kinds.includes(record.kind)) continue;
		records.push(record);
	}
	return options.limit !== undefined && records.length > options.limit ? records.slice(-options.limit) : records;
}

/** One line per record, for the step brief and `/tasks show`. */
export function renderTaskLogLine(record: TaskLogRecord): string {
	switch (record.kind) {
		case "step":
			return `- [${record.ts}] step ${record.seq} → ${record.outcome}: ${record.note}`;
		case "round":
			return `- [${record.ts}] round ${record.n} ${record.verdict.toUpperCase()} (${record.strength}) verify=${record.verifyRunId}${record.workRunId ? ` work=${record.workRunId}` : ""}${record.reason ? ` — ${record.reason}` : ""}`;
		case "expired":
			return `- [${record.ts}] 等待票过期（${record.ticket}）→ ${record.action}`;
		case "close":
			return `- [${record.ts}] cycle ${record.cycle} ${record.outcome}: ${record.summary}`;
	}
}
