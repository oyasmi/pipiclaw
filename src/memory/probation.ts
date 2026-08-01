import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { applyChannelMemoryOps, type MemoryOp } from "./files.js";
import { readMemoryMetadata } from "./metadata.js";

/**
 * How long a probationary memory entry survives without being recalled (spec 037, D7/D8).
 * A code constant, not a setting: the durable/probation split is an algorithm parameter, same
 * class as `minMemoryAutoWriteConfidence` before it (spec 035's `RETIRED_SETTINGS_KEYS`).
 */
export const MEMORY_PROBATION_DAYS = 30;

export function probationDeadline(now: Date = new Date()): string {
	return formatLocalTime(new Date(now.getTime() + MEMORY_PROBATION_DAYS * 24 * 60 * 60 * 1000));
}

function isPast(value: string | undefined, nowMs: number): boolean {
	if (!value) return false;
	const ms = parseLocalTime(value);
	return ms !== undefined && ms <= nowMs;
}

/**
 * Active entries whose probation lapsed, or whose (otherwise unconsumed) `expiresAt` was
 * reached. Both are "this entry's time is up" — they share one eviction path even though their
 * semantics differ: `probationUntil` is cancelled by use, `expiresAt` is unconditional.
 */
export function collectExpiredEntryIds(
	metadata: Awaited<ReturnType<typeof readMemoryMetadata>>,
	now: Date = new Date(),
): string[] {
	const nowMs = now.getTime();
	return Object.values(metadata.entries)
		.filter(
			(entry) =>
				entry.status === "active" && (isPast(entry.probationUntil, nowMs) || isPast(entry.expiresAt, nowMs)),
		)
		.map((entry) => entry.id);
}

/**
 * Evict every expired entry via `invalidate`, never `forget` (spec 037, D8): probation lapsing
 * means "not needed right now", not "must never be written again" — a tombstone would permanently
 * block the same fact from being relearned later, which is the wrong failure mode for a
 * confidence-gated background write.
 */
export async function expireMemoryEntries(channelDir: string, now: Date = new Date()): Promise<number> {
	const metadata = await readMemoryMetadata(channelDir);
	const expiredIds = collectExpiredEntryIds(metadata, now);
	if (expiredIds.length === 0) return 0;
	const ops: MemoryOp[] = expiredIds.map((targetId) => ({
		op: "invalidate",
		targetId,
		reason: "probation expired without being recalled",
	}));
	const result = await applyChannelMemoryOps(channelDir, ops, formatLocalTime(now));
	return result.invalidated;
}
