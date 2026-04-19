import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

const writeChains = new Map<string, Promise<void>>();

export function getMemoryReviewLogPath(channelDir: string): string {
	return join(channelDir, "memory-review.jsonl");
}

function enqueueWrite<T>(path: string, work: () => Promise<T>): Promise<T> {
	const previous = writeChains.get(path) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(() => work());
	const completion = result.then(
		() => undefined,
		() => undefined,
	);
	writeChains.set(path, completion);
	completion.finally(() => {
		if (writeChains.get(path) === completion) {
			writeChains.delete(path);
		}
	});
	return result;
}

async function rotateIfNeeded(path: string): Promise<void> {
	try {
		const stats = await stat(path);
		if (stats.size < REVIEW_LOG_MAX_BYTES) {
			return;
		}
		const rotated = `${path}.1`;
		try {
			// Read existing rotated file and current file, keep only the newest half
			const current = await readFile(path, "utf-8");
			const lines = current.split("\n").filter(Boolean);
			const keepLines = lines.slice(-Math.floor(lines.length / 2));
			await writeFile(rotated, `${keepLines.join("\n")}\n`, "utf-8");
		} catch {
			// If rotation fails, just rename
			await rename(path, rotated).catch(() => {});
		}
		await writeFile(path, "", "utf-8");
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
	await enqueueWrite(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, line, "utf-8");
		await rotateIfNeeded(path);
	});
}
