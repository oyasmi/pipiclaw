import { existsSync, mkdirSync, renameSync, statSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { createSerialQueue, type SerialQueue } from "../shared/serial-queue.js";
import { ensureChannelDir } from "./channel-paths.js";

const MAX_LOG_SIZE_BYTES = 1_000_000;
const DEDUPE_TTL_MS = 60_000;
const DEDUPE_CLEANUP_INTERVAL_MS = 30_000;

export interface LoggedMessage {
	date: string;
	ts: string;
	user: string;
	userName?: string;
	displayName?: string;
	text: string;
	isBot: boolean;
	deliveryMode?: "steer" | "followUp";
	skipContextSync?: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
}

export interface LoggedSubAgentRun {
	date: string;
	toolCallId: string;
	label: string;
	agent: string;
	source: "predefined" | "inline";
	model: string;
	tools: string[];
	turns: number;
	toolCalls: number;
	durationMs: number;
	failed: boolean;
	failureReason?: string;
	output: string;
	outputTruncated: boolean;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
	};
}

export class ChannelStore {
	private workingDir: string;
	private recentlyLogged = new Map<string, number>();
	private cleanupTimer: NodeJS.Timeout | null = null;
	private writeQueue: SerialQueue<string> = createSerialQueue<string>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;

		// Ensure working directory exists
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * Get or create the directory for a channel/DM
	 */
	getChannelDir(channelId: string): string {
		return ensureChannelDir(this.workingDir, channelId);
	}

	/**
	 * Log a message to the channel's log.jsonl raw archive.
	 * This file is cold storage and is not proactively loaded into memory context.
	 * Returns false if message was already logged (duplicate)
	 */
	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		const dedupeKey = `${channelId}:${message.ts}`;
		const now = Date.now();
		const previousLogTime = this.recentlyLogged.get(dedupeKey);
		if (previousLogTime !== undefined) {
			if (now - previousLogTime < DEDUPE_TTL_MS) {
				return false;
			}
			this.recentlyLogged.delete(dedupeKey);
		}

		this.recentlyLogged.set(dedupeKey, now);
		this.startCleanupTimer();

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		if (!message.date) {
			message.date = new Date().toISOString();
		}

		await this.writeQueue.run(logPath, async () => {
			await this.rotateIfNeeded(logPath);
			const line = `${JSON.stringify(message)}\n`;
			await appendFile(logPath, line, "utf-8");
		});
		return true;
	}

	async logSubAgentRun(channelId: string, run: LoggedSubAgentRun): Promise<void> {
		const logPath = join(this.getChannelDir(channelId), "subagent-runs.jsonl");
		await this.writeQueue.run(logPath, async () => {
			await this.rotateIfNeeded(logPath);
			const line = `${JSON.stringify(run)}\n`;
			await appendFile(logPath, line, "utf-8");
		});
	}

	/**
	 * Rotate log file if it exceeds 1MB.
	 * Keeps one backup (log.jsonl.1) and resets the sync offset.
	 */
	private async rotateIfNeeded(logPath: string): Promise<void> {
		try {
			if (!existsSync(logPath)) return;
			const stats = statSync(logPath);
			if (stats.size > MAX_LOG_SIZE_BYTES) {
				renameSync(logPath, `${logPath}.1`);
				const syncOffsetPath = join(dirname(logPath), ".sync-offset");
				try {
					await writeFile(syncOffsetPath, "0", "utf-8");
				} catch {
					/* ignore */
				}
			}
		} catch {
			// Ignore rotation errors
		}
	}

	/**
	 * Log a bot response
	 */
	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			isBot: true,
		});
	}

	private startCleanupTimer(): void {
		if (this.cleanupTimer) {
			return;
		}
		this.cleanupTimer = setInterval(() => {
			this.cleanupExpiredEntries();
		}, DEDUPE_CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref?.();
	}

	private cleanupExpiredEntries(now = Date.now()): void {
		const cutoff = now - DEDUPE_TTL_MS;
		for (const [key, loggedAt] of this.recentlyLogged) {
			if (loggedAt <= cutoff) {
				this.recentlyLogged.delete(key);
			}
		}
		if (this.recentlyLogged.size === 0 && this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
	}
}
