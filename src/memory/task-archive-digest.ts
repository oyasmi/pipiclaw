import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getMemoryWorkDir } from "../desk/paths.js";
import * as log from "../log.js";
import type { ModelRequests } from "../models/requests.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime, localDayKey, parseLocalTime } from "../shared/local-time.js";
import { isNodeError, readOptionalTextFile } from "../shared/os.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { type DeskMemoryQueue, type DeskMemoryTarget, getDeskMemoryQueue } from "./desk-memory-queue.js";
import { appendJournalEntries } from "./journal.js";
import { runReflect } from "./reflect.js";
import { reviewLogEntryFor, tryAppendMemoryReviewLog } from "./review-log.js";

/**
 * Pull-based task archive digester (B1): reads `tasks/archive/*.md` + `*.jsonl` directly from the
 * desk directory (never imports `tasks/`), tracking progress via `.memory-work/tasks.json`.
 *
 * - Recurring event instances (frontmatter `origin` set) append one deterministic journal line
 *   without calling an LLM.
 * - One-off tasks run one `runReflect` pass over the distilled contract + reports + close note,
 *   allowing stale agent memories to be resolved once a task fixes them.
 * - On first run with no watermark file, initializes the watermark to `initialWatermarkMs` so
 *   pre-existing historical archives are never backfilled.
 */

export interface TaskArchiveWatermark {
	version: 1;
	throughClosedAtMs: number;
	throughIds: string[];
	failureBackoffUntilMs?: number | null;
}

export interface ArchivedTaskCandidate {
	id: string;
	closedAtMs: number;
	closedAt: string;
	outcome: string;
	origin?: string;
	channel?: string;
	title: string;
	markdown: string;
	logNotes: string[];
	closeNote?: string;
	hasUserMessage: boolean;
}

export interface TaskArchiveReflectRuntime {
	workspaceDir: string;
	model: Model<Api>;
	modelRequests: ModelRequests;
	resolveFallbackModel?: () => Promise<Model<Api> | null>;
}

export interface DigestTaskArchivesOptions {
	target: DeskMemoryTarget;
	now?: Date;
	/** Watermark floor used when `.memory-work/tasks.json` does not exist yet (no backfill). */
	initialWatermarkMs?: number;
	failureBackoffMinutes?: number;
	/** Lazily resolved only when a one-off task actually requires an LLM reflect pass. */
	loadReflectRuntime: () => Promise<TaskArchiveReflectRuntime | null>;
	queue?: DeskMemoryQueue;
}

export interface DigestTaskArchivesResult {
	initialized: boolean;
	recurringDigested: number;
	oneOffDigested: number;
	usedLlm: boolean;
}

const DEFAULT_FAILURE_BACKOFF_MINUTES = 30;
const RECURRING_SUMMARY_MAX_CHARS = 140;

export function getTaskArchiveWatermarkPath(deskDir: string): string {
	return join(getMemoryWorkDir(deskDir), "tasks.json");
}

async function readWatermark(deskDir: string): Promise<TaskArchiveWatermark | null> {
	const raw = await readOptionalTextFile(getTaskArchiveWatermarkPath(deskDir));
	if (!raw.trim()) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			isRecord(parsed) &&
			parsed.version === 1 &&
			typeof parsed.throughClosedAtMs === "number" &&
			Number.isFinite(parsed.throughClosedAtMs) &&
			Array.isArray(parsed.throughIds) &&
			parsed.throughIds.every((id) => typeof id === "string")
		) {
			return {
				version: 1,
				throughClosedAtMs: parsed.throughClosedAtMs,
				throughIds: parsed.throughIds,
				failureBackoffUntilMs:
					typeof parsed.failureBackoffUntilMs === "number" && Number.isFinite(parsed.failureBackoffUntilMs)
						? parsed.failureBackoffUntilMs
						: null,
			};
		}
	} catch {
		/* treat corrupt watermark as absent below */
	}
	return null;
}

async function writeWatermark(deskDir: string, watermark: TaskArchiveWatermark): Promise<void> {
	await writeFileAtomically(getTaskArchiveWatermarkPath(deskDir), `${JSON.stringify(watermark, null, 2)}\n`);
}

function advanceWatermark(
	current: TaskArchiveWatermark,
	task: Pick<ArchivedTaskCandidate, "id" | "closedAtMs">,
): TaskArchiveWatermark {
	if (task.closedAtMs > current.throughClosedAtMs) {
		return {
			version: 1,
			throughClosedAtMs: task.closedAtMs,
			throughIds: [task.id],
			failureBackoffUntilMs: null,
		};
	}
	if (task.closedAtMs === current.throughClosedAtMs) {
		const throughIds = current.throughIds.includes(task.id) ? current.throughIds : [...current.throughIds, task.id];
		return {
			version: 1,
			throughClosedAtMs: current.throughClosedAtMs,
			throughIds,
			failureBackoffUntilMs: null,
		};
	}
	return { ...current, failureBackoffUntilMs: null };
}

function isAfterWatermark(watermark: TaskArchiveWatermark, closedAtMs: number, id: string): boolean {
	if (closedAtMs > watermark.throughClosedAtMs) return true;
	if (closedAtMs < watermark.throughClosedAtMs) return false;
	return !watermark.throughIds.includes(id);
}

function parseFrontmatterField(markdown: string, key: string): string | undefined {
	if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return undefined;
	const end = markdown.indexOf("\n---", 3);
	if (end < 0) return undefined;
	const header = markdown.slice(4, end);
	const match = new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, "m").exec(header);
	return match?.[1]?.trim() || undefined;
}

function extractTitle(markdown: string, fallbackId: string): string {
	const match = /^#\s+(.+)$/m.exec(markdown);
	return match?.[1]?.trim() || fallbackId;
}

function parseTaskTimestampMs(value: string | undefined, fallbackMs: number): number {
	if (!value) return fallbackMs;
	const parsed = parseLocalTime(value);
	return parsed !== undefined && Number.isFinite(parsed) ? parsed : fallbackMs;
}

function formatHourMinute(ms: number): string {
	const date = new Date(ms);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${hh}:${mm}`;
}

function formatOutcomeLabel(outcome: string): string {
	if (outcome === "completed" || outcome === "complete") return "已完成";
	if (outcome === "cancelled" || outcome === "cancel") return "已取消";
	return outcome;
}

function buildRecurringJournalLine(task: ArchivedTaskCandidate): string {
	const hhmm = formatHourMinute(task.closedAtMs);
	const firstLine = (task.closeNote ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	const rawSummary = firstLine || task.title;
	const summary =
		rawSummary.length > RECURRING_SUMMARY_MAX_CHARS
			? `${rawSummary.slice(0, RECURRING_SUMMARY_MAX_CHARS - 1)}…`
			: rawSummary;
	return `${hhmm} 任务 ${task.id}（${formatOutcomeLabel(task.outcome)}）：${summary}`;
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readPendingArchivedTasks(
	deskDir: string,
	watermark: TaskArchiveWatermark,
): Promise<ArchivedTaskCandidate[]> {
	const archiveDir = join(deskDir, "tasks", "archive");
	let names: string[];
	try {
		names = (await readdir(archiveDir)).filter((name) => name.endsWith(".md"));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}

	const candidates: ArchivedTaskCandidate[] = [];
	for (const fileName of names) {
		const id = fileName.slice(0, -".md".length);
		const mdPath = join(archiveDir, fileName);
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(mdPath);
			if (!info.isFile()) continue;
		} catch {
			continue;
		}
		// Fast mtime pre-check: an archive file is written at close time, so files older than
		// the watermark by more than a small clock-skew margin can be skipped without reading.
		if (info.mtimeMs + 60_000 < watermark.throughClosedAtMs) continue;

		const markdown = await readOptionalTextFile(mdPath);
		if (!markdown.trim()) continue;
		const outcome = parseFrontmatterField(markdown, "outcome") ?? "closed";
		const origin = parseFrontmatterField(markdown, "origin");
		const channel = parseFrontmatterField(markdown, "channel");
		const frontmatterClosedAt = parseFrontmatterField(markdown, "closedAt");

		const logContent = await readOptionalTextFile(join(archiveDir, `${id}.jsonl`));
		const logNotes: string[] = [];
		let closedAtStr = frontmatterClosedAt;
		let closeNote: string | undefined;
		let hasUserMessage = false;
		for (const line of logContent.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			if (parsed.kind === "report") {
				const text = getStringField(parsed, "text");
				if (text) logNotes.push(`[汇报] ${text}`);
			} else if (parsed.kind === "ask") {
				const question = getStringField(parsed, "question");
				if (question) logNotes.push(`[提问] ${question}`);
			} else if (parsed.kind === "message") {
				const text = getStringField(parsed, "text");
				if (text) {
					hasUserMessage = true;
					logNotes.push(`[用户消息] ${text}`);
				}
			} else if (parsed.kind === "close" || parsed.kind === "closed") {
				closedAtStr = getStringField(parsed, "ts") ?? closedAtStr;
				const closeOutcome = getStringField(parsed, "outcome") ?? outcome;
				const note = getStringField(parsed, "note");
				if (note) closeNote = note;
				logNotes.push(`[结项 ${closeOutcome}]${note ? ` ${note}` : ""}`);
			}
		}

		const closedAtMs = parseTaskTimestampMs(closedAtStr, info.mtimeMs);
		if (!isAfterWatermark(watermark, closedAtMs, id)) continue;

		candidates.push({
			id,
			closedAtMs,
			closedAt: closedAtStr ?? new Date(closedAtMs).toISOString(),
			outcome,
			origin,
			channel,
			title: extractTitle(markdown, id),
			markdown: markdown.trim(),
			logNotes,
			closeNote,
			hasUserMessage,
		});
	}

	candidates.sort((a, b) => a.closedAtMs - b.closedAtMs || a.id.localeCompare(b.id));
	return candidates;
}

async function hasAnyArchivedTasks(deskDir: string): Promise<boolean> {
	try {
		return (await readdir(join(deskDir, "tasks", "archive"))).some((name) => name.endsWith(".md"));
	} catch (error) {
		if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
		throw error;
	}
}

/**
 * Digest newly closed archived tasks for one desk.
 * Serializes writes through `DeskMemoryQueue` and spends at most one LLM call per invocation.
 */
export async function digestTaskArchives(options: DigestTaskArchivesOptions): Promise<DigestTaskArchivesResult> {
	const now = options.now ?? new Date();
	const queue = options.queue ?? getDeskMemoryQueue();
	const result: DigestTaskArchivesResult = {
		initialized: false,
		recurringDigested: 0,
		oneOffDigested: 0,
		usedLlm: false,
	};
	if (!(await hasAnyArchivedTasks(options.target.deskDir))) {
		return result;
	}

	await queue.run(options.target, async () => {
		let watermark = await readWatermark(options.target.deskDir);
		if (!watermark) {
			watermark = {
				version: 1,
				throughClosedAtMs: options.initialWatermarkMs ?? now.getTime(),
				throughIds: [],
				failureBackoffUntilMs: null,
			};
			await writeWatermark(options.target.deskDir, watermark);
			result.initialized = true;
		}
		if (watermark.failureBackoffUntilMs && watermark.failureBackoffUntilMs > now.getTime()) {
			return;
		}

		const pending = await readPendingArchivedTasks(options.target.deskDir, watermark);
		if (pending.length === 0) return;

		for (const task of pending) {
			const day = localDayKey(new Date(task.closedAtMs));
			if (task.origin) {
				const line = buildRecurringJournalLine(task);
				const appended = await appendJournalEntries(options.target.deskDir, day, [line]);
				watermark = advanceWatermark(watermark, task);
				await writeWatermark(options.target.deskDir, watermark);
				result.recurringDigested++;
				await tryAppendMemoryReviewLog(options.target.deskDir, {
					timestamp: formatLocalTime(now),
					channelId: task.channel ?? "",
					reason: "task-digest",
					correlationId: `task:${task.id}`,
					actions:
						appended.appended > 0
							? [
									{
										target: "journal",
										action: "append",
										count: appended.appended,
										taskId: task.id,
										origin: task.origin,
									},
								]
							: [],
				});
				continue;
			}

			// One-off task: run reflect once, then stop this tick (at most 1 LLM call per tick).
			const runtime = await options.loadReflectRuntime();
			if (!runtime) return;

			const bodyParts = [
				`[Closed task ${task.id}: ${task.title}]`,
				`Outcome: ${task.outcome}`,
				`ClosedAt: ${task.closedAt}`,
				"",
				task.markdown,
			];
			if (task.logNotes.length > 0) {
				bodyParts.push("", "Task reports and close notes:", ...task.logNotes);
			}

			try {
				const reflectResult = await runReflect({
					channelId: task.channel,
					deskDir: options.target.deskDir,
					workspaceDir: runtime.workspaceDir,
					model: runtime.model,
					modelRequests: runtime.modelRequests,
					resolveFallbackModel: runtime.resolveFallbackModel,
					messages: [],
					sourceText: {
						label: `Closed one-off task archive to reflect on (${task.id}, outcome=${task.outcome})`,
						text: bodyParts.join("\n"),
						hasUserMessage: task.hasUserMessage,
					},
					today: day,
					usageContext: {
						channelId: task.channel ?? "",
						desk: options.target.desk,
						correlationId: `task:${task.id}`,
					},
				});
				watermark = advanceWatermark(watermark, task);
				await writeWatermark(options.target.deskDir, watermark);
				result.oneOffDigested++;
				result.usedLlm = true;
				await tryAppendMemoryReviewLog(options.target.deskDir, {
					timestamp: formatLocalTime(now),
					channelId: task.channel ?? "",
					reason: "task-digest",
					correlationId: `task:${task.id}`,
					...reviewLogEntryFor(reflectResult),
				});
			} catch (error) {
				const backoffMs = (options.failureBackoffMinutes ?? DEFAULT_FAILURE_BACKOFF_MINUTES) * 60_000;
				await writeWatermark(options.target.deskDir, {
					...watermark,
					failureBackoffUntilMs: now.getTime() + Math.max(0, backoffMs),
				}).catch(() => undefined);
				const message = errorMessage(error);
				log.logWarn("memory.task_digest.failed", "Task archive digest failed", {
					channelId: task.channel,
					reason: message,
					fields: { desk: options.target.desk, taskId: task.id },
				});
				await tryAppendMemoryReviewLog(options.target.deskDir, {
					timestamp: formatLocalTime(now),
					channelId: task.channel ?? "",
					reason: "task-digest",
					correlationId: `task:${task.id}`,
					error: message,
				});
			}
			return;
		}
	});

	return result;
}
