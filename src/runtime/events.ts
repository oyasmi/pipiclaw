import { Cron } from "croner";
import { existsSync, type FSWatcher, mkdirSync, readdirSync, statSync, unlinkSync, watch, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import * as log from "../log.js";
import type { Executor } from "../sandbox.js";
import { guardCommand } from "../security/command-guard.js";
import type { SecurityConfig } from "../security/types.js";
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

// ============================================================================
// EventsWatcher
// ============================================================================

const DEBOUNCE_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;
const MAX_TIMEOUT_MS = 2_147_483_647;

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
	) {
		this.startTime = Date.now();
	}

	start(): void {
		if (!existsSync(this.eventsDir)) {
			mkdirSync(this.eventsDir, { recursive: true });
		}

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
	}

	private cancelScheduled(filename: string): void {
		const timer = this.timers.get(filename);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(filename);
		}

		const cron = this.crons.get(filename);
		if (cron) {
			cron.stop();
			this.crons.delete(filename);
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
			this.markInvalid(filename, lastError?.message ?? "Unknown event parse error");
			return;
		}

		this.knownFiles.add(filename);
		this.clearInvalidMarker(filename);

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

	private parsePreAction(data: Record<string, unknown>, filename: string): EventAction | undefined {
		if (!data.preAction) return undefined;
		if (typeof data.preAction !== "object" || data.preAction === null) {
			throw new Error(`Invalid 'preAction' field in ${filename}, expected an object`);
		}

		const action = data.preAction as Record<string, unknown>;
		if (action.type !== "bash") {
			throw new Error(
				`Unsupported preAction type '${String(action.type)}' in ${filename}, only 'bash' is supported`,
			);
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

	private parseEvent(content: string, filename: string): ScheduledEvent | null {
		const data = JSON.parse(content);

		if (!data.type || !data.channelId || !data.text) {
			throw new Error(`Missing required fields (type, channelId, text) in ${filename}`);
		}

		const preAction = this.parsePreAction(data, filename);

		switch (data.type) {
			case "immediate":
				return { type: "immediate", channelId: data.channelId, text: data.text, preAction };

			case "one-shot":
				if (!data.at) {
					throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
				}
				return { type: "one-shot", channelId: data.channelId, text: data.text, at: data.at, preAction };

			case "periodic":
				if (!data.schedule) {
					throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
				}
				if (!data.timezone) {
					throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
				}
				return {
					type: "periodic",
					channelId: data.channelId,
					text: data.text,
					schedule: data.schedule,
					timezone: data.timezone,
					preAction,
				};

			default:
				throw new Error(`Unknown event type '${data.type}' in ${filename}`);
		}
	}

	private async handleImmediate(filename: string, event: ImmediateEvent): Promise<void> {
		const filePath = join(this.eventsDir, filename);

		try {
			const stat = statSync(filePath);
			if (stat.mtimeMs < this.startTime) {
				log.logInfo(`Stale immediate event, deleting: ${filename}`);
				this.deleteFile(filename);
				return;
			}
		} catch {
			return;
		}

		log.logInfo(`Executing immediate event: ${filename}`);
		await this.execute(filename, event);
	}

	private handleOneShot(filename: string, event: OneShotEvent): void {
		const atTime = new Date(event.at).getTime();
		const now = Date.now();

		if (!Number.isFinite(atTime)) {
			log.logWarning(`Invalid one-shot time for ${filename}: ${event.at}`);
			this.markInvalid(filename, `Invalid one-shot time: ${event.at}`);
			return;
		}

		if (atTime <= now) {
			log.logInfo(`One-shot event in the past, deleting: ${filename}`);
			this.deleteFile(filename);
			return;
		}

		const delay = atTime - now;
		if (delay > MAX_TIMEOUT_MS) {
			log.logWarning(
				`One-shot event exceeds maximum supported delay for ${filename}: ${event.at}. Use a periodic cron event instead.`,
			);
			this.markInvalid(filename, `One-shot event exceeds maximum supported delay: ${event.at}`);
			return;
		}

		log.logInfo(`Scheduling one-shot event: ${filename} in ${Math.round(delay / 1000)}s`);

		const timer = setTimeout(async () => {
			this.timers.delete(filename);
			try {
				log.logInfo(`Executing one-shot event: ${filename}`);
				await this.execute(filename, event);
			} catch (err) {
				log.logWarning(`One-shot event execution failed: ${filename}`, String(err));
			}
		}, delay);

		this.timers.set(filename, timer);
	}

	private handlePeriodic(filename: string, event: PeriodicEvent): void {
		try {
			const cron = new Cron(event.schedule, { timezone: event.timezone }, async () => {
				try {
					log.logInfo(`Executing periodic event: ${filename}`);
					await this.execute(filename, event, false);
				} catch (err) {
					log.logWarning(`Periodic event execution failed: ${filename}`, String(err));
				}
			});

			this.crons.set(filename, cron);

			const next = cron.nextRun();
			log.logInfo(`Scheduled periodic event: ${filename}, next run: ${next?.toISOString() ?? "unknown"}`);
		} catch (err) {
			log.logWarning(`Invalid cron schedule for ${filename}: ${event.schedule}`, String(err));
			this.markInvalid(filename, `Invalid cron schedule: ${event.schedule}\n${String(err)}`);
		}
	}

	private async execute(filename: string, event: ScheduledEvent, deleteAfter: boolean = true): Promise<void> {
		if (event.preAction) {
			try {
				await this.runPreAction(event.preAction, filename);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				log.logInfo(`Pre-action gate blocked event: ${filename} (${reason})`);
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

		if (enqueued && deleteAfter) {
			this.deleteFile(filename);
		} else if (!enqueued) {
			log.logWarning(`Event queue full, discarded: ${filename}`);
			if (deleteAfter) {
				this.deleteFile(filename);
			}
		}
	}

	private async runPreAction(action: EventAction, filename: string): Promise<void> {
		if (this.commandGuardConfig?.enabled) {
			const guardResult = guardCommand(action.command, this.commandGuardConfig);
			if (!guardResult.allowed) {
				log.logWarning(`Pre-action command blocked by guard for ${filename}: ${guardResult.reason}`);
				throw new Error(`guard: ${guardResult.reason}`);
			}
		}

		const timeoutMs = action.timeout ?? 10_000;
		const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
		const result = await this.executor.exec(action.command, { timeout: timeoutSeconds });
		if (result.code !== 0) {
			throw new Error(`exit ${result.code}`);
		}
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
): EventsWatcher {
	const eventsDir = join(workspaceDir, "events");
	return new EventsWatcher(eventsDir, bot, executor, commandGuardConfig);
}
