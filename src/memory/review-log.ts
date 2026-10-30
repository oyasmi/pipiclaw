import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";

import type { ReflectRunResult } from "./reflect.js";

/** Spec 050, D10: the idle reflect job, a boundary-triggered reflect run, or a memory tool event. */
export type MemoryReviewReason = "reflect" | "reflect-boundary" | "memory-save" | "memory-forget";

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

/** An audit failure must not replay an already committed reflection. */
export async function tryAppendMemoryReviewLog(deskDir: string, entry: MemoryReviewLogEntry): Promise<void> {
	try {
		await appendMemoryReviewLog(deskDir, entry);
	} catch (error) {
		log.logWarn("memory.review_log.write_failed", "Memory review log write failed", {
			channelId: entry.channelId,
			reason: errorMessage(error),
		});
	}
}

const REVIEW_LOG_MAX_BYTES = 1_024 * 1_024; // 1 MB
// Three job kinds share a log per desk (path), so the key space is path x reason.
const MAX_GATE_SKIP_KEYS = 768;

const writeQueue = createSerialQueue<string>();
const lastGateSkipByKey = new Map<string, string>();

function gateSkipKey(path: string, reason: MemoryReviewReason): string {
	return `${path}\u0000${reason}`;
}

export function getMemoryReviewLogPath(deskDir: string): string {
	return join(deskDir, "memory-review.jsonl");
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

export async function appendMemoryReviewLog(deskDir: string, entry: MemoryReviewLogEntry): Promise<void> {
	const path = getMemoryReviewLogPath(deskDir);
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

/** Shared by the idle job and `lifecycle.ts`'s boundary calls, so both write the same shape. */
export function reviewLogEntryFor(
	result: ReflectRunResult,
	source?: { fromEntryId?: string; throughEntryId?: string; hasMore: boolean; sampledChars: number },
): {
	actions?: unknown[];
	skipped?: unknown[];
} {
	const actions: unknown[] = [...(result.decisions ?? [])];
	if (source?.hasMore || source?.sampledChars) {
		actions.push({
			target: "source",
			action: source.sampledChars ? "sample" : "batch",
			fromEntryId: source.fromEntryId,
			throughEntryId: source.throughEntryId,
			hasMore: source.hasMore,
			sampledChars: source.sampledChars,
		});
	}
	if (result.added.length || result.updated.length || result.deleted.length || result.touched.length) {
		actions.push({
			target: "memory",
			action: "reflect",
			added: result.added,
			updated: result.updated,
			deleted: result.deleted,
			touched: result.touched,
			condensed: result.condensed,
		});
	}
	if (result.journalAppended > 0) {
		actions.push({ target: "journal", action: "append", count: result.journalAppended });
	}
	if (result.expiredProbation.length > 0) {
		actions.push({ target: "memory", action: "expire", entries: result.expiredProbation });
	}
	const skipped: unknown[] = result.rejected.map((item) => ({ target: "memory", ...item }));
	if (result.skipped) skipped.push({ target: "reflect", reason: "no meaningful exchange" });
	return { actions, skipped: skipped.length > 0 ? skipped : undefined };
}
