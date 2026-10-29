import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import { formatLocalTime } from "../shared/local-time.js";
import { clipText, truncate } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { normalizeTaskId } from "./contract.js";
import type { TaskBudget, TaskFrontmatter } from "./frontmatter.js";
import { withTaskMutation } from "./mutation-lock.js";

/**
 * The task's append-only loop log (spec 051, D5; spec 064, D3) — `tasks/<id>.jsonl`.
 *
 * Every input to the task (a settlement, a stall report, a user message, a resume) is appended here
 * *before* the lane is told. Inputs remain pending until their identity appears in a persisted
 * user message in the task transcript and an `input_ack` records that receipt (INV-6). The
 * log rotates at `MAX_LOG_BYTES` and keeps two rotated backups (`.1`, `.2`) alongside the current
 * file: `readTaskLog`/`archiveTask` must enumerate all three, or whatever had already rotated out is
 * silently dropped (R9). The log is append-only and is never rewritten (INV-9).
 */
export type TaskStepReason = "start" | "input" | "continue" | "resume" | "retry";
export type TaskStepResult = "ok" | "timeout" | "error" | "aborted" | "interrupted";
export type TaskStepNext = "continue" | "work" | "user" | "time" | "closed" | "paused";

/** A step began: written by the lane before the model is called. */
export interface TaskStepRecord {
	ts: string;
	kind: "step";
	seq: number;
	reason: TaskStepReason;
	brief: "full" | "delta";
}

/** A step ended. `step` without `step_end` means the process died mid-step (D10 repairs it). */
export interface TaskStepEndRecord {
	ts: string;
	kind: "step_end";
	seq: number;
	result: TaskStepResult;
	next: TaskStepNext;
	/** The model's last reply of the step: what it did, the evidence, what comes next. */
	note: string;
	tools: string[];
	usd?: number;
	usdEstimated?: boolean;
	error?: string;
	close?: { outcome: "complete" | "cancel"; note: string };
}

export interface TaskInputAckRecord {
	ts: string;
	kind: "input_ack";
	ids: string[];
}

export interface TaskAskDeliveredRecord {
	ts: string;
	kind: "ask_delivered";
	seq: number;
}

export interface TaskCheckpointRecord {
	ts: string;
	kind: "checkpoint";
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
	/**
	 * The result was returned to the step inside the very tool call that started the work, so it is
	 * not news to anyone: it stays on the board but is not an input that wakes or briefs (D3).
	 */
	inline?: boolean;
}

/** An external run has produced no output for a long while; the leader decides what to do (D16). */
export interface TaskStallRecord {
	ts: string;
	kind: "stall";
	ref: string;
	silentMinutes: number;
}

/** The user said something to the task; only a durable input receipt consumes it. */
export interface TaskMessageRecord {
	ts: string;
	kind: "message";
	from: string;
	channel: string;
	text: string;
}

export interface TaskAskRecord {
	ts: string;
	kind: "ask";
	seq: number;
	question: string;
}

export interface TaskWaitRecord {
	ts: string;
	kind: "wait";
	seq: number;
	until: string;
}

export interface TaskReportRecord {
	ts: string;
	kind: "report";
	seq: number;
	text: string;
	delivered: boolean;
}

export interface TaskPauseRecord {
	ts: string;
	kind: "pause";
	by: "user" | "runtime";
	reason: string;
}

export interface TaskResumeRecord {
	ts: string;
	kind: "resume";
	grants?: Partial<TaskBudget>;
}

export interface TaskCloseRecord {
	ts: string;
	kind: "close";
	outcome: "done" | "cancelled";
	by: "leader" | "user";
	note: string;
	steps: number;
	usd: number;
}

export type TaskLogRecord = (
	| TaskInputAckRecord
	| TaskAskDeliveredRecord
	| TaskCheckpointRecord
	| TaskStepRecord
	| TaskStepEndRecord
	| TaskDispatchRecord
	| TaskSettleRecord
	| TaskStallRecord
	| TaskMessageRecord
	| TaskAskRecord
	| TaskWaitRecord
	| TaskReportRecord
	| TaskPauseRecord
	| TaskResumeRecord
	| TaskCloseRecord
) & { id?: string; checkpoint?: TaskFrontmatter };

/** Same rotation shape as the channel archive: the log is working history, not an audit trail. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const NOTE_MAX_CHARS = 4_000;

export function taskLogPath(deskDir: string, id: string): string {
	return join(deskDir, "tasks", `${normalizeTaskId(id)}.jsonl`);
}

/** Where `archiveTask` moves a closed task's `.jsonl`. */
export function taskArchiveLogPath(deskDir: string, id: string): string {
	return join(deskDir, "tasks", "archive", `${normalizeTaskId(id)}.jsonl`);
}

/** True when the loop log for `id` lives only in the archive (the task is closed). */
export function taskLogIsArchived(deskDir: string, id: string): boolean {
	return !existsSync(taskLogPath(deskDir, id)) && existsSync(taskArchiveLogPath(deskDir, id));
}

const appenders = new Map<string, JsonlAppender>();

function appenderFor(path: string, deskDir: string, id: string): JsonlAppender {
	const existing = appenders.get(path);
	if (existing) return existing;
	const appender = createJsonlAppender({
		path,
		maxSizeBytes: MAX_LOG_BYTES,
		maxRotations: 2,
		canRotate: async () => {
			if (!existsSync(`${path}.2`)) return true;
			const records = await readTaskLog(deskDir, id, { strict: true });
			const latest = (kind: TaskLogRecord["kind"]) => [...records].reverse().find((record) => record.kind === kind);
			const required = [
				...newInputs(records),
				...records.filter((record) => record.kind === "settle"),
				latest("step"),
				latest("resume"),
				latest("ask_delivered"),
				latest("close"),
				...stepEndsSinceResume(records).slice(-3),
				[...records].reverse().find((record) => record.checkpoint),
			];
			const pinned = new Set(required.flatMap((record) => (record?.id ? [record.id] : [])));
			const oldest: TaskLogRecord[] = [];
			parseLogLines(await readFile(`${path}.2`, "utf-8"), {}, oldest);
			return !oldest.some((record) => record.id && pinned.has(record.id));
		},
	});
	appenders.set(path, appender);
	return appender;
}

/** Test seam: drop cached appenders so a temp-dir fixture does not leak into the next case. */
export async function resetTaskLogAppenders(): Promise<void> {
	const open = [...appenders.values()];
	appenders.clear();
	await Promise.all(open.map((appender) => appender.close()));
}

type OmitTs<T> = T extends unknown ? Omit<T, "ts"> : never;

export type TaskLogInput = OmitTs<TaskLogRecord>;

/**
 * Append one record. `appendStrict` rather than `append`: the loop log is the only durable trace
 * of what a step did, so a dropped record would make the next brief lie about the task's history.
 */
export async function appendTaskLog(
	deskDir: string,
	id: string,
	record: TaskLogInput & { ts?: string },
): Promise<string> {
	const withTs = { ts: record.ts ?? formatLocalTime(), ...record, id: record.id ?? randomUUID() };
	if (withTs.kind === "step_end") withTs.note = clipText(withTs.note, NOTE_MAX_CHARS);
	if (withTs.kind === "report" || withTs.kind === "message") withTs.text = clipText(withTs.text, NOTE_MAX_CHARS);
	// Under the task's mutation lock: the appender rotates by size, and two processes rotating
	// one log at once would each move the other's fresh records aside.
	await withTaskMutation(deskDir, id, () => appenderFor(taskLogPath(deskDir, id), deskDir, id).appendStrict(withTs));
	return withTs.id;
}

const RECORD_KINDS: readonly TaskLogRecord["kind"][] = [
	"input_ack",
	"ask_delivered",
	"checkpoint",
	"step",
	"step_end",
	"dispatch",
	"settle",
	"stall",
	"message",
	"ask",
	"wait",
	"report",
	"pause",
	"resume",
	"close",
];

/** Only the current record shapes are read: a `step` without `reason` is a pre-064 record. */
function toRecord(value: unknown): TaskLogRecord | undefined {
	if (!isPlainObject(value) || typeof value.ts !== "string") return undefined;
	const kind = value.kind;
	if (typeof kind !== "string" || !(RECORD_KINDS as readonly string[]).includes(kind)) return undefined;
	if (kind === "step" && (typeof value.seq !== "number" || typeof value.reason !== "string")) return undefined;
	return value as unknown as TaskLogRecord;
}

export interface ReadTaskLogOptions {
	/** Keep at most this many, counted from the end (the most recent). */
	limit?: number;
	kinds?: readonly TaskLogRecord["kind"][];
	/** Recovery must distinguish unreadable storage from an empty history. */
	strict?: boolean;
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
	deskDir: string,
	id: string,
	options: ReadTaskLogOptions = {},
): Promise<TaskLogRecord[]> {
	// Fall back to the archived copy so `task_log` on a completed task returns its history rather
	// than "暂无日志" — a task that finished still has a loop log worth reading.
	const basePath = existsSync(taskLogPath(deskDir, id)) ? taskLogPath(deskDir, id) : taskArchiveLogPath(deskDir, id);
	const paths = shardPaths(basePath);
	if (paths.length === 0) return [];
	const records: TaskLogRecord[] = [];
	for (const path of paths) {
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			if (options.strict) throw error;
			continue;
		}
		parseLogLines(content, options, records);
	}
	return options.limit !== undefined && records.length > options.limit ? records.slice(-options.limit) : records;
}

/** One line per record, for the step brief and `task_log` (model-facing; `/tasks` uses `renderTaskLogLineForUser`). */
export function renderTaskLogLine(record: TaskLogRecord): string {
	const at = `[${record.ts}]`;
	switch (record.kind) {
		case "input_ack":
		case "checkpoint":
			return "";
		case "ask_delivered":
			return `- ${at} step ${record.seq} 提问已送达`;
		case "step":
			return `- ${at} step ${record.seq} 开始（${record.reason}，${record.brief === "full" ? "完整" : "增量"} brief）`;
		case "step_end":
			return `- ${at} step ${record.seq} 结束 ${record.result} → ${record.next}${record.tools.length > 0 ? `（工具：${record.tools.join(", ")}）` : ""}: ${record.note}${record.error ? ` · 错误：${record.error}` : ""}`;
		case "dispatch":
			return `- ${at} 派发 ${record.ref}${record.item ? ` → ${record.item}` : ""}${record.agent ? ` (${record.agent}${record.purpose === "verify" ? ", verify" : ""})` : ""}`;
		case "settle":
			return `- ${at} 结算 ${record.ref}: ${record.status}${record.verdict ? ` VERDICT ${record.verdict.toUpperCase()}` : ""}${record.exitCode !== undefined ? ` exit ${record.exitCode}` : ""}${record.output ? ` · ${record.output}` : ""}`;
		case "stall":
			return `- ${at} 卡顿 ${record.ref}: 已 ${record.silentMinutes} 分钟没有输出`;
		case "message":
			return `- ${at} 用户消息（${record.from}）: ${record.text}`;
		case "ask":
			return `- ${at} step ${record.seq} 向用户提问: ${record.question}`;
		case "wait":
			return `- ${at} step ${record.seq} 约定等到 ${record.until}`;
		case "report":
			return `- ${at} step ${record.seq} 汇报${record.delivered ? "" : "（未送达）"}: ${record.text}`;
		case "pause":
			return `- ${at} 暂停（${record.by}）: ${record.reason}`;
		case "resume":
			return `- ${at} 恢复${record.grants ? `，追加预算 ${JSON.stringify(record.grants)}` : ""}`;
		case "close":
			return `- ${at} ${record.outcome === "done" ? "完成" : "取消"}（${record.by}）：${record.note}`;
	}
}

/** `2026-10-11T14:02:33.000+08:00` → `10-11 14:02`: read straight off the stored wall-clock text, never re-zoned. */
function minuteStamp(ts: string): string {
	const match = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
	return match ? `${match[1]} ${match[2]}` : ts;
}

/** A run id is `run_…`; anything else bound to a task is a background job. */
export function describeWorkRef(ref: string): string {
	return /^run_/i.test(ref) ? `委派 \`${ref}\`` : `后台作业 \`${ref}\``;
}

const SETTLE_STATUS: Record<string, string> = {
	completed: "完成",
	failed: "失败",
	cancelled: "已取消",
	lost: "已丢失",
	running: "进行中",
};

/** A settled run/job's outcome in words: `完成，验收通过` / `失败（退出码 1）`. */
export function describeSettlement(settle: Pick<TaskSettleRecord, "status" | "verdict" | "exitCode">): string {
	const parts = [SETTLE_STATUS[settle.status] ?? settle.status];
	if (settle.verdict) parts.push(settle.verdict === "pass" ? "验收通过" : "验收未通过");
	const exit = settle.exitCode !== undefined && settle.exitCode !== 0 ? `（退出码 ${settle.exitCode}）` : "";
	return `${parts.join("，")}${exit}`;
}

function oneLine(text: string, max: number): string {
	return truncate(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * One line per record for `/tasks show` and `/tasks log` (spec 053, D2). The same records as
 * `renderTaskLogLine`, said in the user's terms: no `result` / `next` values, no `VERDICT`, no
 * tool names, minute precision.
 */
export function renderTaskLogLineForUser(record: TaskLogRecord): string {
	const at = minuteStamp(record.ts);
	switch (record.kind) {
		case "input_ack":
		case "checkpoint":
			return "";
		case "ask_delivered":
			return `- ${at} 提问已送达`;
		case "step":
			return `- ${at} 开始第 ${record.seq} 步`;
		case "step_end": {
			const outcome =
				record.result === "ok"
					? oneLine(record.note, 160)
					: record.result === "timeout"
						? "这一步超时，已中止"
						: record.result === "error"
							? "这一步出错"
							: record.result === "aborted"
								? "这一步被中止"
								: "这一步被服务重启打断";
			return `- ${at} 第 ${record.seq} 步结束：${outcome}`;
		}
		case "dispatch": {
			const who =
				record.agent && record.agent !== "job"
					? `（${record.agent}${record.purpose === "verify" ? "，验收" : ""}）`
					: "";
			return `- ${at} 开始${describeWorkRef(record.ref)}${who}${record.item ? `，对应工作项 ${record.item}` : ""}`;
		}
		case "settle":
			return `- ${at} ${describeWorkRef(record.ref)}结束：${describeSettlement(record)}`;
		case "stall":
			return `- ${at} ${describeWorkRef(record.ref)}已 ${record.silentMinutes} 分钟没有输出`;
		case "message":
			return `- ${at} 你说：${oneLine(record.text, 120)}`;
		case "ask":
			return `- ${at} 向你提问：${oneLine(record.question, 160)}`;
		case "wait":
			return `- ${at} 约定等到 ${minuteStamp(record.until)}`;
		case "report":
			return `- ${at} 向你汇报${record.delivered ? "" : "（未送达）"}：${oneLine(record.text, 160)}`;
		case "pause":
			return `- ${at} ${record.by === "user" ? "你暂停了任务" : "系统暂停了任务"}：${oneLine(record.reason, 120)}`;
		case "resume":
			return `- ${at} 任务已恢复`;
		case "close":
			return `- ${at} ${record.outcome === "done" ? "任务完成" : "任务取消"}：${oneLine(record.note, 160)}`;
	}
}

// === Cursors over the log (spec 064, D3/D16) ===

/** The last `step` record, and whether a `step_end` for it exists. `undefined` before the first step. */
export function lastStep(records: readonly TaskLogRecord[]): { step: TaskStepRecord; ended: boolean } | undefined {
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index];
		if (record?.kind !== "step") continue;
		const ended = records.slice(index + 1).some((later) => later.kind === "step_end" && later.seq === record.seq);
		return { step: record, ended };
	}
	return undefined;
}

/** A record that wakes a waiting task and is shown to the next step. */
export type TaskInputRecord = (TaskSettleRecord | TaskStallRecord | TaskMessageRecord | TaskResumeRecord) & {
	id?: string;
};

/**
 * Pending inputs, in journal order. Starting a step or accepting a steer never consumes them.
 * Inline results are already returned by their tool; other inputs need a durable receipt.
 */
export function newInputs(records: readonly TaskLogRecord[]): TaskInputRecord[] {
	const consumed = new Set(records.flatMap((record) => (record.kind === "input_ack" ? record.ids : [])));
	const inputs: TaskInputRecord[] = [];
	const seen = new Set<string>();
	for (const record of records) {
		if (record.id && (consumed.has(record.id) || seen.has(record.id))) continue;
		if (record.id) seen.add(record.id);
		if (record.kind === "stall" || record.kind === "resume") inputs.push(record);
		else if (record.kind === "settle" && !record.inline) inputs.push(record);
		else if (record.kind === "message") inputs.push(record);
	}
	return inputs;
}

/**
 * The `step_end` records since the user last resumed the task, oldest first. A guard (idle, timeout,
 * error) counts only these: a resume is the user looking at the problem, so the same evidence must
 * not pause the task a second time.
 */
export function stepEndsSinceResume(records: readonly TaskLogRecord[]): Array<TaskStepEndRecord & { id?: string }> {
	let from = 0;
	for (let index = records.length - 1; index >= 0; index--) {
		if (records[index]?.kind === "resume") {
			from = index + 1;
			break;
		}
	}
	return records.slice(from).filter((record): record is TaskStepEndRecord => record.kind === "step_end");
}
