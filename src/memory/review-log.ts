import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";

export type MemoryReviewReason =
	| "idle"
	| "compaction"
	| "new-session"
	| "shutdown"
	| "post-turn"
	| "session-refresh-job"
	| "durable-consolidation-job"
	| "growth-review-job"
	| "structural-maintenance-job";

export interface MemoryReviewLogEntry {
	timestamp: string;
	channelId: string;
	reason: MemoryReviewReason;
	candidates?: unknown[];
	actions?: unknown[];
	suggestions?: unknown[];
	skipped?: unknown[];
	error?: string;
}

const REVIEW_LOG_MAX_BYTES = 1_024 * 1_024; // 1 MB

const writeQueue = createSerialQueue<string>();

export function getMemoryReviewLogPath(channelDir: string): string {
	return join(channelDir, "memory-review.jsonl");
}

async function rotateIfNeeded(path: string, incomingBytes: number): Promise<void> {
	try {
		const stats = await stat(path);
		if (stats.size + incomingBytes < REVIEW_LOG_MAX_BYTES) {
			return;
		}
		const rotated = `${path}.1`;
		const current = await readFile(path, "utf-8");
		const lines = current.split("\n").filter(Boolean);
		const keepLines = lines.slice(-Math.floor(lines.length / 2));
		await writeFileAtomically(rotated, keepLines.length > 0 ? `${keepLines.join("\n")}\n` : "");
		await writeFileAtomically(path, "");
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return;
		}
		// Rotation failure is non-fatal
	}
}

export async function appendMemoryReviewLog(channelDir: string, entry: MemoryReviewLogEntry): Promise<void> {
	const path = getMemoryReviewLogPath(channelDir);
	const line = `${JSON.stringify(entry)}\n`;
	await writeQueue.run(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await rotateIfNeeded(path, Buffer.byteLength(line, "utf-8"));
		await appendFile(path, line, "utf-8");
	});
}
