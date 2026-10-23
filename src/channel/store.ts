/**
 * The message archive: each channel's `log.jsonl` (inbound messages, bot responses) in its
 * conversation directory, and each desk's `subagent-runs.jsonl`, with de-duplication, size
 * rotation and a debounced flush.
 */
import { writeFile } from "fs/promises";
import { basename, dirname, join } from "path";
import * as log from "../log.js";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";
import { formatLocalTime } from "../shared/local-time.js";

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
	/**
	 * Paths of any images the user sent alongside `text` (spec 049), relative to the desk
	 * directory. Kept even for an image that never made it into the model's context (unsupported
	 * format, oversized, model without vision support) — this is the only place that record
	 * survives once the turn's `[图片N: ...]` marker has scrolled out of `HISTORY.md`.
	 */
	images?: string[];
}

export interface ChannelStoreConfig {
	/**
	 * Where a channel's archive goes right now (spec 058, D17): its conversation directory in the
	 * desk it is bound to. `undefined` for an unbound channel, which is not archived at all.
	 */
	resolveArchiveDir: (channelId: string) => string | undefined;
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
	/** Spec 040, D7: the run this entry archives, and its lifecycle context. Only set on terminal archiving. */
	runId?: string;
	runtime?: "internal" | "external";
	harness?: "claude-code" | "codex-cli" | "exec";
	status?: "completed" | "failed" | "cancelled" | "lost";
	taskId?: string;
	artifactDir?: string;
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
	private readonly resolveArchiveDir: ChannelStoreConfig["resolveArchiveDir"];
	private recentlyLogged = new Map<string, number>();
	private cleanupTimer: NodeJS.Timeout | null = null;
	private archiveAppender: JsonlAppender;
	private closed = false;

	constructor(config: ChannelStoreConfig) {
		this.resolveArchiveDir = config.resolveArchiveDir;
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
	}

	/**
	 * Log a message to the channel's log.jsonl raw archive.
	 * This file is cold storage and is not proactively loaded into memory context.
	 * Returns false if the message was already logged (duplicate), or the channel is unbound.
	 */
	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		if (this.closed) {
			throw new Error("Channel archive is closed. Retry after the runtime has restarted.");
		}
		// Resolved, not created: the appender's own `ensureDir` creates the directory before it
		// writes, and memoizes it — a sync mkdir here would block on every progress update.
		const archiveDir = this.resolveArchiveDir(channelId);
		if (!archiveDir) {
			log.logDebugEvent("channel.archive.skipped", "Archive skipped: channel not bound to a desk", { channelId });
			return false;
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

		const logPath = join(archiveDir, "log.jsonl");

		if (!message.date) {
			message.date = formatLocalTime();
		}

		if (!this.archiveAppender.tryAppend({ filePath: logPath, value: message }, "critical")) {
			throw new Error("Channel archive queue is full. Retry this message after pending log writes drain.");
		}
		this.recentlyLogged.set(dedupeKey, now);
		this.startCleanupTimer();
		return true;
	}

	/**
	 * Archive a settled run in the desk it ran in. Takes the desk directory rather than resolving the
	 * channel: a run that settles after its channel was rebound still belongs to its own desk.
	 */
	async logSubAgentRun(deskDir: string, run: LoggedSubAgentRun): Promise<void> {
		if (this.closed) return;
		const logPath = join(deskDir, "subagent-runs.jsonl");
		if (!this.archiveAppender.tryAppend({ filePath: logPath, value: run })) {
			throw new Error("Sub-agent archive queue is full. Retry after pending log writes drain.");
		}
	}

	/**
	 * Log a bot response
	 */
	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: formatLocalTime(),
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
