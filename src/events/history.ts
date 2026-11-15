import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import * as log from "../log.js";
import { createJsonlAppender, type JsonlAppender } from "../shared/jsonl-appender.js";

export const EVENT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const EVENT_HISTORY_ROTATIONS = 2;

/**
 * Shared per-path appenders: every desk's `EventsWatcher` writes into the same app-level
 * `events-history.jsonl`, so they must share one serialized queue and file-size cache for
 * size-based rotation to stay race-free across desks.
 */
const appenders = new Map<string, JsonlAppender>();

export function getEventHistoryAppender(path: string, maxSizeBytes = EVENT_HISTORY_MAX_BYTES): JsonlAppender {
	const key = `${path}:${maxSizeBytes}`;
	let appender = appenders.get(key);
	if (!appender) {
		appender = createJsonlAppender({
			path,
			maxSizeBytes,
			maxRotations: EVENT_HISTORY_ROTATIONS,
			maxPendingRecords: 4_000,
			maxPendingBytes: 8 * 1024 * 1024,
		});
		appenders.set(key, appender);
	}
	return appender;
}

export function ensureEventHistoryFile(historyPath: string): void {
	try {
		mkdirSync(dirname(historyPath), { recursive: true, mode: 0o700 });
		writeFileSync(historyPath, "", { flag: "a", mode: 0o600 });
		chmodSync(historyPath, 0o600);
	} catch (err) {
		log.logWarn("events.history.init_failed", "Event history file init failed", { reason: String(err) });
	}
}

/**
 * Read retained history shards from oldest to newest (`.2` → `.1` → active file) so `/events history`
 * remains continuous right across a rotation boundary.
 */
export async function readEventHistoryLines(historyPath: string): Promise<string[]> {
	const shards = [
		...Array.from(
			{ length: EVENT_HISTORY_ROTATIONS },
			(_, index) => `${historyPath}.${EVENT_HISTORY_ROTATIONS - index}`,
		),
		historyPath,
	];
	const lines: string[] = [];
	for (const shard of shards) {
		if (!existsSync(shard)) continue;
		try {
			const raw = await readFile(shard, "utf-8");
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (trimmed) lines.push(trimmed);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return lines;
}
