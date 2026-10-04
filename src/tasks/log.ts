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
 * it here keeps the contract small enough to inject whole (INV-6) while making the history much
 * longer before anything is folded away: the log rotates at `MAX_LOG_BYTES` and keeps two rotated
 * backups (`.1`, `.2`) alongside the current file — bounded retention, not an accidental cap.
 * `readTaskLog`/`archiveTask` must enumerate all three; reading or archiving only the current
 * file silently drops whatever had already rotated out of it (R9).
 *
 * Spec 052 adds `dispatch` / `settle` records: the run and job managers write them when work is
 * bound to the task and when it settles, so the task keeps the outcome of every delegation long
 * after the run record itself has been garbage-collected (INV-5). The step brief renders them as
 * the `<task_board>`. The log is append-only and is never rewritten.
 */
export type TaskStepOutcome = "continue" | "park" | "done";

export interface TaskStepRecord {
	ts: string;
	kind: "step";
	seq: number;
	outcome: TaskStepOutcome;
	note: string;
	tools: string[];
	/** What this step sent the user, when it sent anything. Kept so the next occurrence knows what was delivered. */
	report?: string;
	usd?: number;
	usdEstimated?: boolean;
	units?: number;
}

/** A delegation or background job was bound to this task (spec 052, D4). `ref` is a run or job id. */
export interface TaskDispatchRecord {
	ts: string;
	kind: "dispatch";
	ref: string;
	/** The Work Items id this dispatch was for, when the leader named one. */
	item?: string;
	/** The role (delegation) or the command (job), for the board. */
	agent?: string;
	purpose?: "work" | "verify";
	label?: string;
}

/**
 * The bound delegation or job settled. Written by the run/job manager at settlement, so the
 * task keeps the outcome after the run record itself has been garbage-collected (INV-5).
 */
export interface TaskSettleRecord {
	ts: string;
	kind: "settle";
	ref: string;
	item?: string;
	status: string;
	/** `purpose=verify` runs only: the checker's declared verdict. */
	verdict?: "pass" | "fail";
	usd?: number;
	usdEstimated?: boolean;
	/** Where the full output lives (a run's `output.md`, a job's output file). */
	output?: string;
	/** The output's tail, as the completion wake shows it. Untrusted executor text, not instructions. */
	tail?: string;
	/** A run's working directory afterwards (`git status --porcelain`), as the completion wake shows it. */
	changed?: string;
	exitCode?: number;
	durationMs?: number;
}

export interface TaskExpiredRecord {
	ts: string;
	kind: "expired";
	ticket: string;
	action: "reopened" | "paused";
}

export interface TaskCloseRecord {
	ts: string;
	kind: "close";
	outcome: "done" | "cancelled";
	note: string;
	steps: number;
	usd: number;
}

/** Written only by the v3 → v5 conversion, to explain a decision it made about this task. */
export interface TaskNoteRecord {
	ts: string;
	kind: "note";
	note: string;
}

export type TaskLogRecord =
	| TaskStepRecord
	| TaskDispatchRecord
	| TaskSettleRecord
	| TaskExpiredRecord
	| TaskCloseRecord
	| TaskNoteRecord;

/** Same rotation shape as the channel archive: the log is working history, not an audit trail. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const NOTE_MAX_CHARS = 4_000;

export function taskLogPath(channelDir: string, id: string): string {
	return join(channelDir, "tasks", `${normalizeTaskId(id)}.jsonl`);
}

/** Where `archiveTask` moves a closed task's `.jsonl`. */
export function taskArchiveLogPath(channelDir: string, id: string): string {
	return join(channelDir, "tasks", "archive", `${normalizeTaskId(id)}.jsonl`);
}

/** True when the loop log for `id` lives only in the archive (the task is closed). */
export function taskLogIsArchived(channelDir: string, id: string): boolean {
	return !existsSync(taskLogPath(channelDir, id)) && existsSync(taskArchiveLogPath(channelDir, id));
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
	| Omit<TaskStepRecord, "ts">
	| Omit<TaskDispatchRecord, "ts">
	| Omit<TaskSettleRecord, "ts">
	| Omit<TaskExpiredRecord, "ts">
	| Omit<TaskCloseRecord, "ts">
	| Omit<TaskNoteRecord, "ts">;

/**
 * Append one record. `appendStrict` rather than `append`: the loop log is the only durable trace
 * of what a step did, so a dropped record would make the next brief lie about the task's history.
 */
export async function appendTaskLog(
	channelDir: string,
	id: string,
	record: TaskLogInput & { ts?: string },
): Promise<void> {
	const withTs = { ts: record.ts ?? formatLocalTime(), ...record };
	if (withTs.kind === "step") {
		withTs.note = clipText(withTs.note, NOTE_MAX_CHARS);
		if (withTs.report) withTs.report = clipText(withTs.report, NOTE_MAX_CHARS);
	}
	await appenderFor(taskLogPath(channelDir, id)).appendStrict(withTs);
}

const RECORD_KINDS: readonly TaskLogRecord["kind"][] = ["step", "dispatch", "settle", "expired", "close", "note"];

function toRecord(value: unknown): TaskLogRecord | undefined {
	if (!isPlainObject(value) || typeof value.ts !== "string") return undefined;
	const kind = value.kind;
	if (typeof kind !== "string" || !(RECORD_KINDS as readonly string[]).includes(kind)) return undefined;
	return value as unknown as TaskLogRecord;
}

export interface ReadTaskLogOptions {
	/** Keep at most this many, counted from the end (the most recent). */
	limit?: number;
	kinds?: readonly TaskLogRecord["kind"][];
}

/** Rotated-shard paths for `basePath`, oldest first, then the current file — the chronological
 * order records were actually written in. Only shards that exist are returned. */
function shardPaths(basePath: string): string[] {
	return [`${basePath}.2`, `${basePath}.1`, basePath].filter((path) => existsSync(path));
}

function parseLogLines(content: string, options: ReadTaskLogOptions, into: TaskLogRecord[]): void {
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
		if (options.kinds && !options.kinds.includes(record.kind)) continue;
		into.push(record);
	}
}

/**
 * Read the log back, newest-last. Unparseable lines are skipped rather than failing the read: a
 * hand-edited or half-written line must not make a task's whole history unreadable.
 *
 * Reads every existing rotated shard (R9), not just the current file — `MAX_LOG_BYTES` rotation
 * moves older records into `.1`/`.2` behind the caller's back, and a read that only looked at the
 * current file made rotated-out history invisible to `task_log`, briefs, and and the board
 * alike even though it was still on disk.
 */
export async function readTaskLog(
	channelDir: string,
	id: string,
	options: ReadTaskLogOptions = {},
): Promise<TaskLogRecord[]> {
	// Fall back to the archived copy so `task_log` on a completed task returns its history rather
	// than "暂无日志" — a task that finished still has a loop log worth reading.
	const basePath = existsSync(taskLogPath(channelDir, id))
		? taskLogPath(channelDir, id)
		: taskArchiveLogPath(channelDir, id);
	const paths = shardPaths(basePath);
	if (paths.length === 0) return [];
	const records: TaskLogRecord[] = [];
	for (const path of paths) {
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch {
			continue;
		}
		parseLogLines(content, options, records);
	}
	return options.limit !== undefined && records.length > options.limit ? records.slice(-options.limit) : records;
}

/** One line per record, for the step brief and `/tasks show`. */
export function renderTaskLogLine(record: TaskLogRecord): string {
	switch (record.kind) {
		case "step":
			return `- [${record.ts}] step ${record.seq} → ${record.outcome}: ${record.note}${record.report ? " · 已向用户汇报" : ""}`;
		case "dispatch":
			return `- [${record.ts}] 派发 ${record.ref}${record.item ? ` → ${record.item}` : ""}${record.agent ? ` (${record.agent}${record.purpose === "verify" ? ", verify" : ""})` : ""}`;
		case "settle":
			return `- [${record.ts}] 结算 ${record.ref}: ${record.status}${record.verdict ? ` VERDICT ${record.verdict.toUpperCase()}` : ""}${record.exitCode !== undefined ? ` exit ${record.exitCode}` : ""}${record.output ? ` · ${record.output}` : ""}`;
		case "expired":
			return `- [${record.ts}] 等待票过期（${record.ticket}）→ ${record.action}`;
		case "close":
			return `- [${record.ts}] ${record.outcome === "done" ? "完成" : "取消"}：${record.note}`;
		case "note":
			return `- [${record.ts}] ${record.note}`;
	}
}
