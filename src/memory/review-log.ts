import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";

/** Spec 050, D10: the idle reflect job, a boundary-triggered reflect run, or a tool/migration event. */
export type MemoryReviewReason = "reflect" | "reflect-boundary" | "memory-save" | "memory-forget" | "migration";

export interface MemoryReviewLogEntry {
	timestamp: string;
	channelId: string;
	reason: MemoryReviewReason;
	/** Joins this outcome to the corresponding sidecar usage-ledger entry. */
	correlationId?: string;
	actions?: unknown[];
	skipped?: unknown[];
	error?: string;
}

const REVIEW_LOG_MAX_BYTES = 1_024 * 1_024; // 1 MB
// Three job kinds share a log per channel (path), so the key space is path x reason.
const MAX_GATE_SKIP_KEYS = 768;

const writeQueue = createSerialQueue<string>();
const lastGateSkipByKey = new Map<string, string>();

function gateSkipKey(path: string, reason: MemoryReviewReason): string {
	return `${path}\u0000${reason}`;
}

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
	const gateSkipOnly = (entry.skipped?.length ?? 0) > 0 && (entry.actions?.length ?? 0) === 0 && !entry.error;
	const key = gateSkipKey(path, entry.reason);
	if (gateSkipOnly) {
		const fingerprint = JSON.stringify({ skipped: entry.skipped });
		if (lastGateSkipByKey.get(key) === fingerprint) return;
		lastGateSkipByKey.delete(key);
		lastGateSkipByKey.set(key, fingerprint);
		if (lastGateSkipByKey.size > MAX_GATE_SKIP_KEYS) {
			const oldestKey = lastGateSkipByKey.keys().next().value;
			if (oldestKey) lastGateSkipByKey.delete(oldestKey);
		}
	} else {
		lastGateSkipByKey.delete(key);
	}
	const line = `${JSON.stringify(entry)}\n`;
	await writeQueue.run(path, async () => {
		await mkdir(dirname(path), { recursive: true });
		await rotateIfNeeded(path, Buffer.byteLength(line, "utf-8"));
		await appendFile(path, line, "utf-8");
	});
}
