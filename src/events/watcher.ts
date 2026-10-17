/**
 * Watches one dot's `events/`, validates each definition, schedules one-shot and periodic events
 * (cron, optional pre-action gate) and enqueues every occurrence through the injected event sink.
 */
import { Cron } from "croner";
import {
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
import type { ChannelEvent, ChannelEventSink } from "../channel/channel-event.js";
import type { ExecResult, Executor } from "../executor.js";
import * as log from "../log.js";
import { guardCommand } from "../security/command-guard.js";
import type { SecurityConfig } from "../security/types.js";
import { writeFileAtomicallySync } from "../shared/atomic-file.js";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { clipText, errorMessage, eventNameFromFilename } from "../shared/text-utils.js";
import type { TaskCreateInput } from "../tasks/contract-input.js";
import { describeEventPayload, parseScheduledEventContent } from "./parse.js";
import type {
	EventAction,
	EventHistoryAction,
	EventHistoryRecord,
	EventHistoryResult,
	EventsWatcherOptions,
	OneShotEvent,
	PeriodicEvent,
	ScheduledEvent,
} from "./types.js";
import { MAX_EVENT_FILES, MAX_ONE_SHOT_DELAY_MS, validateScheduledEvent } from "./validation.js";

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
const SCAN_CONCURRENCY = 4;
const DEFAULT_PRE_ACTION_TIMEOUT_MS = 10_000;
const TEXT_PREVIEW_MAX_CHARS = 160;

function truncateTextPreview(text: string): string {
	return clipText(text, TEXT_PREVIEW_MAX_CHARS, { headRatio: 1, omitHint: "…", collapseWhitespace: true });
}

function eventDispatchId(dot: string, filename: string, event: ScheduledEvent, occurrence: Date): string {
	const name = eventNameFromFilename(filename);
	const when = event.type === "one-shot" ? event.at : occurrence.toISOString();
	return `event:${dot}:${name}:${when}`;
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
	private started = false;
	private knownFiles: Set<string> = new Set();
	private readonly historyAppender?: JsonlAppender;

	constructor(
		private eventsDir: string,
		private bot: ChannelEventSink,
		private executor: Executor,
		private commandGuardConfig: SecurityConfig["commandGuard"] | undefined,
		private options: EventsWatcherOptions,
	) {
		this.startTime = Date.now();
		this.historyAppender = options.historyPath
			? createJsonlAppender({
					path: options.historyPath,
					maxPendingRecords: 4_000,
					maxPendingBytes: 8 * 1024 * 1024,
				})
			: undefined;
	}

	start(): void {
		this.started = true;
		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}
		this.ensureHistoryFile();

		log.logInfo(`Events watcher starting, dir: ${this.eventsDir}`);

		void this.scanExisting();

		this.watcher = watch(this.eventsDir, (_eventType, filename) => {
			if (!filename || !filename.endsWith(".json")) return;
			this.debounce(filename, () => this.handleFileChange(filename));
		});

		log.logInfo(`Events watcher started, tracking ${this.knownFiles.size} files`);
	}

	stop(): void {
		this.started = false;
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

	async flush(): Promise<void> {
		await this.historyAppender?.flush();
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
			log.logWarn("events.history.init_failed", "Event history file init failed", { reason: String(err) });
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
			ts: formatLocalTime(),
			eventName: eventNameFromFilename(filename),
			eventPath: resolve(this.eventsDir, filename),
			dot: this.options.dot,
			...rest,
		};
		if (!this.historyAppender?.tryAppend(fullRecord, "critical")) {
			log.logWarn("events.history.queue_full", "Event history write dropped while earlier writes drain");
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
			textPreview: truncateTextPreview(describeEventPayload(event)),
			...(event.type === "one-shot" ? { at: event.at } : {}),
			...(event.type === "periodic" ? { schedule: event.schedule } : {}),
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

	private async scanExisting(): Promise<void> {
		let files: string[];
		try {
			files = readdirSync(this.eventsDir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			log.logWarn("events.dir.read_failed", "Events directory read failed", { reason: String(err) });
			return;
		}

		for (let offset = 0; this.started && offset < files.length; offset += SCAN_CONCURRENCY) {
			await Promise.all(
				files.slice(offset, offset + SCAN_CONCURRENCY).map(async (filename) => {
					try {
						await this.handleFile(filename);
					} catch (err) {
						log.logWarn("events.file.restore_failed", "Event file restore failed", {
							reason: errorMessage(err),
							fields: { file: filename },
						});
					}
				}),
			);
		}
	}

	private handleFileChange(filename: string): void {
		const filePath = join(this.eventsDir, filename);

		if (!existsSync(filePath)) {
			this.handleDelete(filename);
		} else if (this.knownFiles.has(filename)) {
			this.cancelScheduled(filename);
			this.handleFileSafely(filename);
		} else {
			this.handleFileSafely(filename);
		}
	}

	/**
	 * Watch callbacks are the top of their own stack, so a rejection here reaches nobody — and
	 * `handleFile` can reject: reloading a due one-shot dispatches it inline, and dispatch
	 * writes to disk. `scanExisting` already wraps its own calls; this is the same guard for
	 * the live path. One bad file must not take the watcher, or the process, down with it.
	 */
	private handleFileSafely(filename: string): void {
		void this.handleFile(filename).catch((err) => {
			log.logWarn("events.file.load_failed", "Event file load failed", {
				reason: errorMessage(err),
				fields: { file: filename },
			});
		});
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
			log.logWarn("events.file.parse_failed", "Event file parse failed", {
				reason: lastError?.message,
				fields: { file: filename, attempts: MAX_RETRIES },
			});
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

		const rejection = this.admissionFailure(filename, event);
		if (rejection) {
			log.logWarn("events.file.rejected", "Event file rejected", { reason: rejection, fields: { file: filename } });
			this.appendEventHistory(filename, event, "invalid", "error", { reason: rejection });
			this.markInvalid(filename, rejection);
			return;
		}

		this.knownFiles.add(filename);
		this.clearInvalidMarker(filename);
		this.appendEventHistory(filename, event, "loaded", "ok");

		switch (event.type) {
			case "one-shot":
				await this.handleOneShot(filename, event);
				break;
			case "periodic":
				this.handlePeriodic(filename, event);
				break;
		}
	}

	private parseEvent(content: string, filename: string): ScheduledEvent | null {
		return parseScheduledEventContent(content, filename);
	}

	/**
	 * The admission gate (spec 031, D4). `event_manage` applies the same rules first, but the
	 * events directory is agent-writable, so a file that arrived any other way is only ever
	 * stopped here. Returns the rejection reason, or undefined when the event may be scheduled.
	 */
	private admissionFailure(filename: string, event: ScheduledEvent): string | undefined {
		if (!this.knownFiles.has(filename) && this.timers.size + this.crons.size >= MAX_EVENT_FILES) {
			return `Too many scheduled events (>= ${MAX_EVENT_FILES}); delete stale events before adding more.`;
		}
		try {
			validateScheduledEvent(event, {
				commandGuardConfig: this.commandGuardConfig,
				// A one-shot whose `at` has already passed is a legitimate post-restart recovery,
				// not a self-trigger, so the lead time only binds files written while this process
				// was running — which is exactly the case the guard exists for.
				enforceOneShotLead: this.wasWrittenAfterStart(filename),
			});
		} catch (error) {
			return errorMessage(error);
		}
		return undefined;
	}

	private wasWrittenAfterStart(filename: string): boolean {
		try {
			return statSync(join(this.eventsDir, filename)).mtimeMs >= this.startTime;
		} catch {
			return false;
		}
	}

	private async handleOneShot(filename: string, event: OneShotEvent): Promise<void> {
		const atTime = parseLocalTime(event.at);
		const now = Date.now();

		if (atTime === undefined) {
			log.logWarn("events.oneshot.invalid_time", "One-shot event time invalid", {
				fields: { file: filename, at: event.at },
			});
			this.appendEventHistory(filename, event, "invalid", "error", { reason: `Invalid one-shot time: ${event.at}` });
			this.markInvalid(filename, `Invalid one-shot time: ${event.at}`);
			return;
		}

		if (atTime <= now) {
			// A persisted dispatch turns a missed one-shot into a safe fire-once-now
			// recovery instead of silently discarding work after a process restart.
			log.logInfo(`Recovering past one-shot event now: ${filename}`);
			this.appendEventHistory(filename, event, "triggered", "ok", { reason: "one-shot recovered after due time" });
			await this.execute(filename, event);
			return;
		}

		const delay = atTime - now;
		if (delay > MAX_ONE_SHOT_DELAY_MS) {
			log.logWarn("events.oneshot.too_far", "One-shot event exceeds the maximum delay; use a periodic event", {
				fields: { file: filename, at: event.at },
			});
			this.appendEventHistory(filename, event, "skipped", "skipped", {
				reason: `One-shot event exceeds maximum supported delay: ${event.at}`,
			});
			this.markInvalid(filename, `One-shot event exceeds maximum supported delay: ${event.at}`);
			return;
		}

		log.logInfo(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);
		this.appendEventHistory(filename, event, "scheduled", "ok", {
			nextRunAt: formatLocalTime(new Date(atTime)),
		});

		const timer = setTimeout(async () => {
			this.timers.delete(filename);
			try {
				log.logInfo(`Executing one-shot event: ${filename}`);
				this.appendEventHistory(filename, event, "triggered", "ok");
				await this.execute(filename, event);
			} catch (err) {
				log.logWarn("events.oneshot.failed", "One-shot event execution failed", {
					reason: String(err),
					fields: { file: filename },
				});
				this.appendEventHistory(filename, event, "skipped", "error", {
					reason: errorMessage(err),
				});
			}
		}, delay);

		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { protect: true, catch: true }, async () => {
				try {
					log.logInfo(`Executing periodic event: ${filename}`);
					this.appendEventHistory(filename, event, "triggered", "ok");
					// Croner exposes the callback start time, which distinguishes live occurrences.
					await this.execute(filename, event, false, cron.currentRun() ?? new Date());
				} catch (err) {
					log.logWarn("events.periodic.failed", "Periodic event execution failed", {
						reason: String(err),
						fields: { file: filename },
					});
					this.appendEventHistory(filename, event, "skipped", "error", {
						reason: errorMessage(err),
					});
				}
			});

			this.crons.set(filename, cron);

			const next = cron.nextRun();
			log.logInfo(`Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`);
			this.appendEventHistory(filename, event, "scheduled", "ok", next ? { nextRunAt: formatLocalTime(next) } : {});
		} catch (err) {
			log.logWarn("events.periodic.invalid_cron", "Periodic event cron invalid", {
				reason: String(err),
				fields: { file: filename, schedule: event.schedule },
			});
			this.appendEventHistory(filename, event, "invalid", "error", {
				reason: `Invalid cron schedule: ${event.schedule}\n${String(err)}`,
			});
			this.markInvalid(filename, `Invalid cron schedule: ${event.schedule}\n${String(err)}`);
		}
	}

	private async execute(
		filename: string,
		event: ScheduledEvent,
		deleteAfter: boolean = true,
		occurrence: Date = new Date(),
	): Promise<void> {
		// Spec 058, D8: an occurrence whose delivery channel is no longer bound to this dot is
		// skipped — before the pre-action gate, which would otherwise run a command for nothing.
		if (!this.options.isBound(event.channelId)) {
			this.appendEventHistory(filename, event, "skipped", "skipped", { reason: "channel_not_bound" });
			// A one-shot has no next occurrence: keep the file with a marker, as a full queue does.
			if (deleteAfter) {
				this.markInvalid(
					filename,
					`Delivery channel ${event.channelId} was not bound to dot ${this.options.dot} at ${new Date().toISOString()}; this occurrence was skipped.`,
				);
			}
			return;
		}
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
				const reason = errorMessage(err);
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
				if (deleteAfter) {
					this.deleteFile(filename);
				}
				return;
			}
		}

		if (event.task) {
			await this.spawnTaskInstance(filename, event, event.task, deleteAfter, occurrence);
			return;
		}

		let scheduleInfo: string;
		switch (event.type) {
			case "one-shot":
				scheduleInfo = event.at;
				break;
			case "periodic":
				scheduleInfo = event.schedule;
				break;
		}

		// The [SILENT] protocol only makes sense for periodic wakes, so it rides the
		// periodic trigger rather than the always-on system prompt (spec 026 §7.3).
		const periodicContract =
			event.type === "periodic"
				? " This is a periodic runtime wake. If it produces no user-visible change or result, reply with exactly [SILENT]."
				: "";
		const message = `[EVENT:${filename}:${event.type}:${scheduleInfo}] ${event.text ?? ""}${periodicContract}`;

		// Create synthetic ChannelEvent
		const syntheticEvent: ChannelEvent = {
			type: "dm",
			channelId: event.channelId,
			user: "EVENT",
			userName: "EVENT",
			text: message,
			ts: Date.now().toString(),
			conversationType: "1",
			dispatchId: eventDispatchId(this.options.dot, filename, event, occurrence),
			dot: this.options.dot,
		};

		const enqueued = this.options.dispatch
			? await this.options.dispatch(syntheticEvent)
			: this.bot.enqueueEvent(syntheticEvent);

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
		log.logWarn("events.enqueue.queue_full", "Event not enqueued: channel queue full", {
			fields: { file: filename },
		});
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

	/**
	 * Deliver a template event: ask the runtime for a fresh task instance (spec 052, D2). The
	 * occurrence is the one this trigger was *due* for — a one-shot's `at`, a periodic's cron tick —
	 * so a post-restart replay of the same occurrence lands on the same instance instead of making a
	 * second one.
	 */
	private async spawnTaskInstance(
		filename: string,
		event: ScheduledEvent,
		template: TaskCreateInput,
		deleteAfter: boolean,
		occurrence: Date,
	): Promise<void> {
		const spawn = this.options.spawnTask;
		const due = event.type === "one-shot" ? new Date(parseLocalTime(event.at) ?? occurrence.getTime()) : occurrence;
		try {
			if (!spawn) throw new Error("this runtime cannot create task instances");
			const result = await spawn({
				eventName: eventNameFromFilename(filename),
				dot: this.options.dot,
				channelId: event.channelId,
				template,
				occurrence: due,
			});
			const delivered = result.outcome === "spawned";
			this.appendEventHistory(filename, event, delivered ? "enqueued" : "skipped", "ok", {
				reason:
					result.outcome === "spawned"
						? `spawned task ${result.id}`
						: result.outcome === "exists"
							? `task ${result.id} already exists for this occurrence`
							: `previous instance ${result.id} is still running`,
			});
			if (deleteAfter) this.deleteFile(filename);
		} catch (err) {
			const reason = errorMessage(err);
			log.logWarn("events.task_spawn.failed", "Task spawn for event failed", {
				reason: reason,
				fields: { file: filename },
			});
			this.appendEventHistory(filename, event, "skipped", "error", { reason });
			if (deleteAfter) {
				this.markInvalid(filename, `Could not create the task instance at ${new Date().toISOString()}: ${reason}`);
			}
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
				log.logWarn("events.preaction.blocked", "Event pre-action blocked by guard", {
					reason: guardResult.reason,
					fields: { file: filename },
				});
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
			throw new EventPreActionError("failed", errorMessage(err), {
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
				log.logWarn("events.file.delete_failed", "Event file delete failed", {
					reason: String(err),
					fields: { file: filename },
				});
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
			writeFileAtomicallySync(
				this.getInvalidMarkerPath(filename),
				[`timestamp: ${formatLocalTime()}`, `file: ${filename}`, "", message.trim()].join("\n"),
			);
		} catch (err) {
			log.logWarn("events.marker.write_failed", "Event error marker write failed", {
				reason: String(err),
				fields: { file: filename },
			});
		}
		this.knownFiles.add(filename);
	}

	private clearInvalidMarker(filename: string): void {
		const markerPath = this.getInvalidMarkerPath(filename);
		try {
			unlinkSync(markerPath);
		} catch (err) {
			if (err instanceof Error && "code" in err && err.code !== "ENOENT") {
				log.logWarn("events.marker.delete_failed", "Event error marker delete failed", {
					reason: String(err),
					fields: { file: filename },
				});
			}
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/** Create the events watcher of one dot: it watches `<dotDir>/events/` (spec 058, D14). */
export function createEventsWatcher(
	input: EventsWatcherOptions & {
		dotDir: string;
		bot: ChannelEventSink;
		executor: Executor;
		commandGuardConfig?: SecurityConfig["commandGuard"];
	},
): EventsWatcher {
	const { dotDir, bot, executor, commandGuardConfig, ...options } = input;
	return new EventsWatcher(join(dotDir, "events"), bot, executor, commandGuardConfig, options);
}
