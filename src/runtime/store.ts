import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
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

interface ArchiveEnvelope {
	filePath: string;
	value: unknown;
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
	private archiveAppender: JsonlAppender;
	private closed = false;

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.archiveAppender = createJsonlAppender({
			pathFor: (_now, record) => (record as ArchiveEnvelope).filePath,
			recordForWrite: (record) => (record as ArchiveEnvelope).value,
			maxSizeBytes: MAX_LOG_SIZE_BYTES,
			maxRotations: 1,
			onRotate: async (filePath) => {
				if (basename(filePath) !== "log.jsonl") return;
				try {
					await writeFile(join(dirname(filePath), ".sync-offset"), "0", "utf-8");
				} catch {
					// A stale sync offset only causes the cold-storage importer to rescan.
				}
			},
		});

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
		if (this.closed) {
			throw new Error("Channel archive is closed. Retry after the runtime has restarted.");
		}
		const dedupeKey = `${channelId}:${message.ts}`;
		const now = Date.now();
		const previousLogTime = this.recentlyLogged.get(dedupeKey);
		if (previousLogTime !== undefined) {
			if (now - previousLogTime < DEDUPE_TTL_MS) {
				return false;
			}
			this.recentlyLogged.delete(dedupeKey);
		}

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		if (!message.date) {
			message.date = new Date().toISOString();
		}

		if (!this.archiveAppender.tryAppend({ filePath: logPath, value: message }, "critical")) {
			throw new Error("Channel archive queue is full. Retry this message after pending log writes drain.");
		}
		this.recentlyLogged.set(dedupeKey, now);
		this.startCleanupTimer();
		return true;
	}

	async logSubAgentRun(channelId: string, run: LoggedSubAgentRun): Promise<void> {
		if (this.closed) return;
		const logPath = join(this.getChannelDir(channelId), "subagent-runs.jsonl");
		if (!this.archiveAppender.tryAppend({ filePath: logPath, value: run })) {
			throw new Error("Sub-agent archive queue is full. Retry after pending log writes drain.");
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

	async flush(): Promise<void> {
		await this.archiveAppender.flush();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		await this.archiveAppender.close();
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
