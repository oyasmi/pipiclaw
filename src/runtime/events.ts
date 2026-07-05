import { Cron } from "croner";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	type FSWatcher,
	mkdirSync,
	readdirSync,
	statSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "fs";
import { readFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import * as log from "../log.js";
import type { ExecResult, Executor } from "../sandbox.js";
import { guardCommand } from "../security/command-guard.js";
import type { SecurityConfig } from "../security/types.js";
import { eventNameFromFilename } from "../shared/text-utils.js";
import type { DingTalkBot, DingTalkEvent } from "./dingtalk.js";

// ============================================================================
// Event Types
// ============================================================================

export interface EventAction {
	type: "bash";
	command: string;
	timeout?: number; // event definition uses milliseconds; converted to Executor seconds
}

export interface ImmediateEvent {
	type: "immediate";
	channelId: string;
	text: string;
	preAction?: EventAction;
}

export interface OneShotEvent {
	type: "one-shot";
	channelId: string;
	text: string;
	at: string; // ISO 8601 with timezone offset
	preAction?: EventAction;
}

export interface PeriodicEvent {
	type: "periodic";
	channelId: string;
	text: string;
	schedule: string; // cron syntax
	timezone: string; // IANA timezone
	preAction?: EventAction;
}

export type ScheduledEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

export type EventHistoryAction =
	| "loaded"
	| "scheduled"
	| "triggered"
	| "skipped"
	| "enqueued"
	| "queue_full"
	| "deleted"
	| "invalid"
	| "pre_action_started"
	| "pre_action_passed"
	| "pre_action_blocked"
	| "pre_action_failed"
	| "cancelled";

export type EventHistoryResult = "ok" | "error" | "skipped";

export interface EventHistoryRecord {
	ts: string;
	eventName: string;
	eventPath: string;
	eventType: ScheduledEvent["type"] | "unknown";
	channelId?: string;
	action: EventHistoryAction;
	result: EventHistoryResult;
	reason?: string;
	schedule?: string;
	timezone?: string;
	at?: string;
	nextRunAt?: string;
	textPreview?: string;
	preAction?: {
		type: "bash";
		command: string;
		timeoutMs: number;
		exitCode?: number | null;
		durationMs?: number;
	};
	queue?: {
		accepted: boolean;
	};
}

export interface EventsWatcherOptions {
	historyPath?: string;
}

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_PRE_ACTION_TIMEOUT_MS = 10_000;
const TEXT_PREVIEW_MAX_CHARS = 160;

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function pad3(value: number): string {
	return String(value).padStart(3, "0");
}

export function formatLocalTimestamp(date: Date = new Date()): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const absOffsetMinutes = Math.abs(offsetMinutes);
	const offsetHours = Math.floor(absOffsetMinutes / 60);
	const offsetRemainderMinutes = absOffsetMinutes % 60;
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}${offsetSign}${pad2(offsetHours)}:${pad2(offsetRemainderMinutes)}`;
}

function truncateTextPreview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > TEXT_PREVIEW_MAX_CHARS
		? `${normalized.slice(0, TEXT_PREVIEW_MAX_CHARS - 1)}…`
		: normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(data: Record<string, unknown>, field: string, filename: string): string {
	const value = data[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
	}
	return value;
}

function parsePreAction(data: Record<string, unknown>, filename: string): EventAction | undefined {
	if (!data.preAction) return undefined;
	if (!isRecord(data.preAction)) {
		throw new Error(`Invalid 'preAction' field in ${filename}, expected an object`);
	}

	const action = data.preAction;
	if (action.type !== "bash") {
		throw new Error(`Unsupported preAction type '${String(action.type)}' in ${filename}, only 'bash' is supported`);
	}
	if (typeof action.command !== "string" || action.command.trim().length === 0) {
		throw new Error(`Missing or empty 'preAction.command' in ${filename}`);
	}
	if (action.timeout !== undefined) {
		if (typeof action.timeout !== "number" || !Number.isFinite(action.timeout) || action.timeout <= 0) {
			throw new Error(`Invalid 'preAction.timeout' in ${filename}, expected a positive millisecond value`);
		}
	}

	return {
		type: "bash",
		command: action.command,
		...(typeof action.timeout === "number" ? { timeout: action.timeout } : {}),
	};
}

export function parseScheduledEventContent(content: string, filename: string): ScheduledEvent {
	const data = JSON.parse(content);
	if (!isRecord(data)) {
		throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
	}

	const type = readRequiredString(data, "type", filename);
	const channelId = readRequiredString(data, "channelId", filename);
	const text = readRequiredString(data, "text", filename);
	const preAction = parsePreAction(data, filename);

	switch (type) {
		case "immediate":
			return { type, channelId, text, ...(preAction ? { preAction } : {}) };

		case "one-shot": {
			if (typeof data.at !== "string" || data.at.trim().length === 0) {
				throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
			}
			return { type, channelId, text, at: data.at, ...(preAction ? { preAction } : {}) };
		}

		case "periodic": {
			if (typeof data.schedule !== "string" || data.schedule.trim().length === 0) {
				throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
			}
			if (typeof data.timezone !== "string" || data.timezone.trim().length === 0) {
				throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
			}
			return {
				type,
				channelId,
				text,
				schedule: data.schedule,
				timezone: data.timezone,
				...(preAction ? { preAction } : {}),
			};
		}

		default:
			throw new Error(`Unknown event type '${type}' in ${filename}`);
	}
}

class EventPreActionError extends Error {
	readonly kind: "blocked" | "failed";
	readonly exitCode?: number;
	readonly durationMs?: number;

	constructor(kind: "blocked" | "failed", message: string, options: { exitCode?: number; durationMs?: number } = {}) {
		super(message);
		this.name = "EventPreActionError";
		this.kind = kind;
		this.exitCode = options.exitCode;
		this.durationMs = options.durationMs;
	}
}

export class EventsWatcher {
	private timers: Map<string, NodeJS.Timeout> = new Map();
	private crons: Map<string, Cron> = new Map();
	private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
	private startTime: number;
	private watcher: FSWatcher | null = null;
	private knownFiles: Set<string> = new Set();

	constructor(
		private eventsDir: string,
		private bot: DingTalkBot,
		private executor: Executor,
		private commandGuardConfig?: SecurityConfig["commandGuard"],
		private options: EventsWatcherOptions = {},
	) {
		this.startTime = Date.now();
	}

	start(): void {
		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}
		this.ensureHistoryFile();

		log.logInfo(`Events watcher starting, dir: ${this.eventsDir}`);

		this.scanExisting();

		this.watcher = watch(this.eventsDir, (_eventType, filename) => {
			if (!filename || !filename.endsWith(".json")) return;
			this.debounce(filename, () => this.handleFileChange(filename));
		});

		log.logInfo(`Events watcher started, tracking ${this.knownFiles.size} files`);
	}

	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}

		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();

		for (const timer of this.timers.values()) {
			clearTimeout(timer);
		}
		this.timers.clear();

		for (const cron of this.crons.values()) {
			cron.stop();
		}
		this.crons.clear();

		this.knownFiles.clear();
		log.logInfo("Events watcher stopped");
	}

	private ensureHistoryFile(): void {
		if (!this.options.historyPath) {
			return;
		}
		try {
			const historyDir = dirname(this.options.historyPath);
			mkdirSync(historyDir, { recursive: true, mode: 0o700 });
			writeFileSync(this.options.historyPath, "", { flag: "a", mode: 0o600 });
			chmodSync(this.options.historyPath, 0o600);
		} catch (err) {
			log.logWarning("Failed to initialize event history file", String(err));
		}
	}

	private appendHistory(
		record: Omit<EventHistoryRecord, "ts" | "eventName" | "eventPath"> & { filename: string },
	): void {
		if (!this.options.historyPath) {
			return;
		}
		const { filename, ...rest } = record;
		const fullRecord: EventHistoryRecord = {
			ts: formatLocalTimestamp(),
			eventName: eventNameFromFilename(filename),
			eventPath: resolve(this.eventsDir, filename),
			...rest,
		};
		try {
			this.ensureHistoryFile();
			appendFileSync(this.options.historyPath, `${JSON.stringify(fullRecord)}\n`, "utf-8");
		} catch (err) {
			log.logWarning("Failed to write event history", String(err));
		}
	}

	private appendEventHistory(
		filename: string,
		event: ScheduledEvent,
		action: EventHistoryAction,
		result: EventHistoryResult,
		extra: Partial<
			Omit<EventHistoryRecord, "ts" | "eventName" | "eventPath" | "eventType" | "channelId" | "action" | "result">
		> = {},
	): void {
		this.appendHistory({
			filename,
			eventType: event.type,
			channelId: event.channelId,
			action,
			result,
			textPreview: truncateTextPreview(event.text),
			...(event.type === "one-shot" ? { at: event.at } : {}),
			...(event.type === "periodic" ? { schedule: event.schedule, timezone: event.timezone } : {}),
			...extra,
		});
	}

	private debounce(filename: string, fn: () => void): void {
		const existing = this.debounceTimers.get(filename);
		if (existing) {
			clearTimeout(existing);
		}
		this.debounceTimers.set(
			filename,
			setTimeout(() => {
				this.debounceTimers.delete(filename);
				fn();
			}, DEBOUNCE_MS),
		);
	}

	private scanExisting(): void {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.logWarning("Failed to read events directory", String(err));
			return;
		}

		for (const filename of files) {
			this.handleFile(filename);
		}
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);

		if (!existsSync(filePath)) {
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			this.cancelScheduled(filename);
			this.handleFile(filename);
		} else {
			this.handleFile(filename);
		}
	}

	private handleDelete(filename: string): void {
		if (!this.knownFiles.has(filename)) return;

		log.logInfo(`Event file deleted: ${filename}`);
		this.cancelScheduled(filename);
		this.knownFiles.delete(filename);
		this.appendHistory({
			filename,
			eventType: "unknown",
			action: "deleted",
			result: "ok",
		});
	}

	private cancelScheduled(filename: string): void {
		let cancelled = false;
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
			cancelled = true;
		}

		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
			cancelled = true;
		}

		if (cancelled) {
			this.appendHistory({
				filename,
				eventType: "unknown",
				action: "cancelled",
				result: "ok",
				reason: "event file changed or was removed",
			});
		}
	}

	private async handleFile(filename: string): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		let event: ScheduledEvent | null = null;
		let lastError: Error | null = null;

		for (let i = 0; i < MAX_RETRIES; i++) {
			try {
				const content = await readFile(filePath, "utf-8");
				event = this.parseEvent(content, filename);
				break;
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (i < MAX_RETRIES - 1) {
					await this.sleep(RETRY_BASE_MS * 2 ** i);
				}
			}
		}

		if (!event) {
			log.logWarning(`Failed to parse event file after ${MAX_RETRIES} retries: ${filename}`, lastError?.message);
			this.appendHistory({
				filename,
				eventType: "unknown",
				action: "invalid",
				result: "error",
				reason: lastError?.message ?? "Unknown event parse error",
			});
			this.markInvalid(filename, lastError?.message ?? "Unknown event parse error");
			return;
		}

		this.knownFiles.add(filename);
		this.clearInvalidMarker(filename);
		this.appendEventHistory(filename, event, "loaded", "ok");

		switch (event.type) {
			case "immediate":
				this.handleImmediate(filename, event);
				break;
			case "one-shot":
				this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private parseEvent(content: string, filename: string): ScheduledEvent | null {
		return parseScheduledEventContent(content, filename);
	}

	private async handleImmediate(filename: string, event: ImmediateEvent): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				log.logInfo(`Stale immediate event, deleting: ${filename}`);
				this.appendEventHistory(filename, event, "skipped", "skipped", { reason: "stale immediate event" });
				this.deleteFile(filename);
				return;
			}
		} catch {
			return;
		}

		log.logInfo(`Executing immediate event: ${filename}`);
		this.appendEventHistory(filename, event, "triggered", "ok");
		await this.execute(filename, event);
	}

	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atTime = new Date(event.at).getTime();
		const now = Date.now();

		if (!Number.isFinite(atTime)) {
			log.logWarning(`Invalid one-shot time for ${filename}: ${event.at}`);
			this.appendEventHistory(filename, event, "invalid", "error", { reason: `Invalid one-shot time: ${event.at}` });
			this.markInvalid(filename, `Invalid one-shot time: ${event.at}`);
			return;
		}

		if (atTime <= now) {
			log.logInfo(`One-shot event in the past, deleting: ${filename}`);
			this.appendEventHistory(filename, event, "skipped", "skipped", { reason: "one-shot event is in the past" });
			this.deleteFile(filename);
			return;
		}

		const delay = atTime - now;
		if (delay > MAX_TIMEOUT_MS) {
			log.logWarning(
				`One-shot event exceeds maximum supported delay for ${filename}: ${event.at}. Use a periodic cron event instead.`,
			);
			this.appendEventHistory(filename, event, "skipped", "skipped", {
				reason: `One-shot event exceeds maximum supported delay: ${event.at}`,
			});
			this.markInvalid(filename, `One-shot event exceeds maximum supported delay: ${event.at}`);
			return;
		}

		log.logInfo(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);
		this.appendEventHistory(filename, event, "scheduled", "ok", {
			nextRunAt: formatLocalTimestamp(new Date(atTime)),
		});

		const timer = setTimeout(async () => {
			this.timers.delete(filename);
			try {
				log.logInfo(`Executing one-shot event: ${filename}`);
				this.appendEventHistory(filename, event, "triggered", "ok");
				await this.execute(filename, event);
			} catch (err) {
				log.logWarning(`One-shot event execution failed: ${filename}`, String(err));
				this.appendEventHistory(filename, event, "skipped", "error", {
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		}, delay);

		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, async () => {
				try {
					log.logInfo(`Executing periodic event: ${filename}`);
					this.appendEventHistory(filename, event, "triggered", "ok");
					await this.execute(filename, event, false);
				} catch (err) {
					log.logWarning(`Periodic event execution failed: ${filename}`, String(err));
					this.appendEventHistory(filename, event, "skipped", "error", {
						reason: err instanceof Error ? err.message : String(err),
					});
				}
			});

			this.crons.set(filename, cron);

			const next = cron.nextRun();
			log.logInfo(`Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`);
			this.appendEventHistory(
				filename,
				event,
				"scheduled",
				"ok",
				next ? { nextRunAt: formatLocalTimestamp(next) } : {},
			);
		} catch (err) {
			log.logWarning(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
			this.appendEventHistory(filename, event, "invalid", "error", {
				reason: `Invalid cron schedule: ${event.schedule}\n${String(err)}`,
			});
			this.markInvalid(filename, `Invalid cron schedule: ${event.schedule}\n${String(err)}`);
		}
	}

	private async execute(filename: string, event: ScheduledEvent, deleteAfter: boolean = true): Promise<void> {
		if (event.preAction) {
			try {
				this.appendEventHistory(filename, event, "pre_action_started", "ok", {
					preAction: {
						type: event.preAction.type,
						command: event.preAction.command,
						timeoutMs: event.preAction.timeout ?? DEFAULT_PRE_ACTION_TIMEOUT_MS,
					},
				});
				const result = await this.runPreAction(event.preAction, filename);
				this.appendEventHistory(filename, event, "pre_action_passed", "ok", {
					preAction: {
						type: event.preAction.type,
						command: event.preAction.command,
						timeoutMs: event.preAction.timeout ?? DEFAULT_PRE_ACTION_TIMEOUT_MS,
						exitCode: result.exitCode,
						durationMs: result.durationMs,
					},
				});
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				log.logInfo(`Pre-action gate blocked event: ${filename} (${reason})`);
				const actionResult = err instanceof EventPreActionError ? err : undefined;
				this.appendEventHistory(
					filename,
					event,
					actionResult?.kind === "failed" ? "pre_action_failed" : "pre_action_blocked",
					actionResult?.kind === "failed" ? "error" : "skipped",
					{
						reason,
						preAction: {
							type: event.preAction.type,
							command: event.preAction.command,
							timeoutMs: event.preAction.timeout ?? DEFAULT_PRE_ACTION_TIMEOUT_MS,
							...(actionResult?.exitCode !== undefined ? { exitCode: actionResult.exitCode } : {}),
							...(actionResult?.durationMs !== undefined ? { durationMs: actionResult.durationMs } : {}),
						},
					},
				);
				return;
			}
		}

		let scheduleInfo: string;
		switch (event.type) {
			case "immediate":
				scheduleInfo = "immediate";
				break;
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		const message = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text}`;

		// Create synthetic DingTalkEvent
		const syntheticEvent: DingTalkEvent = {
			type: "dm",
			channelId: event.channelId,
			user: "EVENT",
			userName: "EVENT",
			text: message,
			ts: Date.now().toString(),
			conversationId: "",
			conversationType: "1",
		};

		const enqueued = this.bot.enqueueEvent(syntheticEvent);

		if (enqueued) {
			this.appendEventHistory(filename, event, "enqueued", "ok", { queue: { accepted: true } });
			if (deleteAfter) {
				this.deleteFile(filename);
			}
			return;
		}

		// Queue full: do not silently drop. Periodic events fire again on their
		// next tick, so just warn. One-shot/immediate events would otherwise be
		// GC'd as "past" with no trace, so leave a visible error marker (and keep
		// the source file) making the loss auditable rather than a silent hole.
		log.logWarning(`Event queue full, could not enqueue: ${filename}`);
		this.appendEventHistory(filename, event, "queue_full", "error", {
			reason: "channel queue full",
			queue: { accepted: false },
		});
		if (deleteAfter) {
			this.markInvalid(
				filename,
				`Event queue was full at ${new Date().toISOString()}; this occurrence was not delivered.`,
			);
		}
	}

	private async runPreAction(
		action: EventAction,
		filename: string,
	): Promise<{ exitCode: number; durationMs: number }> {
		const startedAt = Date.now();
		if (this.commandGuardConfig?.enabled) {
			const guardResult = guardCommand(action.command, this.commandGuardConfig);
			if (!guardResult.allowed) {
				log.logWarning(`Pre-action command blocked by guard for ${filename}: ${guardResult.reason}`);
				throw new EventPreActionError("blocked", `guard: ${guardResult.reason}`, {
					durationMs: Date.now() - startedAt,
				});
			}
		}

		const timeoutMs = action.timeout ?? DEFAULT_PRE_ACTION_TIMEOUT_MS;
		const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
		let result: ExecResult;
		try {
			result = await this.executor.exec(action.command, { timeout: timeoutSeconds });
		} catch (err) {
			throw new EventPreActionError("failed", err instanceof Error ? err.message : String(err), {
				durationMs: Date.now() - startedAt,
			});
		}
		if (result.code !== 0) {
			throw new EventPreActionError("blocked", `exit ${result.code}`, {
				exitCode: result.code,
				durationMs: Date.now() - startedAt,
			});
		}
		return { exitCode: result.code, durationMs: Date.now() - startedAt };
	}

	private deleteFile(filename: string): void {
		const filePath = join(this.eventsDir, filename);
		try {
			unlinkSync(filePath);
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				log.logWarning(`Failed to delete event file: ${filename}`, String(err));
			}
		}
		this.clearInvalidMarker(filename);
		this.knownFiles.delete(filename);
		this.appendHistory({
			filename,
			eventType: "unknown",
			action: "deleted",
			result: "ok",
		});
	}

	private getInvalidMarkerPath(filename: string): string {
		return join(this.eventsDir, `${filename}.error.txt`);
	}

	private markInvalid(filename: string, message: string): void {
		try {
			writeFileSync(
				this.getInvalidMarkerPath(filename),
				[`timestamp: ${new Date().toISOString()}`, `file: ${filename}`, "", message.trim()].join("\n"),
				"utf-8",
			);
		} catch (err) {
			log.logWarning(`Failed to write event error marker: ${filename}`, String(err));
		}
		this.knownFiles.add(filename);
	}

	private clearInvalidMarker(filename: string): void {
		const markerPath = this.getInvalidMarkerPath(filename);
		try {
			unlinkSync(markerPath);
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				log.logWarning(`Failed to delete event error marker: ${filename}`, String(err));
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create and start an events watcher.
 */
export function createEventsWatcher(
	workspaceDir: string,
	bot: DingTalkBot,
	executor: Executor,
	commandGuardConfig?: SecurityConfig["commandGuard"],
	historyPath?: string,
): EventsWatcher {
	const eventsDir = join(workspaceDir, "events");
	return new EventsWatcher(eventsDir, bot, executor, commandGuardConfig, { historyPath });
}
