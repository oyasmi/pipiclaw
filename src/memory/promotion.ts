export type MemoryPromotionTarget = "channel-memory";

export interface MemoryPromotionCandidate {
	target: MemoryPromotionTarget;
	op: "add" | "supersede" | "invalidate";
	targetId?: string;
	content?: string;
	kind: "fact" | "preference" | "decision" | "constraint" | "open-loop" | "lesson";
	confidence: number;
	reason: string;
	necessity: "low" | "medium" | "high";
}

export const DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE = 0.85;

/**
 * Confidence bar for a `necessity: "medium"` candidate to enter the durable file at all — as a
 * probationary entry, not permanently (spec 037, D6). Higher than the durable bar: "not
 * necessary but useful" needs more certainty to earn a slot than "necessary".
 */
export const MEMORY_PROBATION_WRITE_CONFIDENCE = 0.9;

/** Per consolidation run, how many probationary entries may be written (spec 037, D6). */
export const MAX_PROBATION_WRITES_PER_RUN = 5;

export type MemoryWriteTier = "durable" | "probationary";

/**
 * Classify a memory candidate into a write tier, or `undefined` to reject it.
 *
 * `necessity` (would future turns break without this?) and `confidence` (how sure is the
 * model?) are orthogonal axes. The gate used to AND them at the strictest tier, which meant a
 * new employee's day-to-day operating knowledge — almost all "medium" necessity — could never
 * be written at all (spec 037 background, L1). Splitting into two tiers lets medium-necessity,
 * high-confidence material in on probation: it must be *used* once (a recall) to become durable,
 * or it expires (`src/memory/probation.ts`). This keeps the durable bar exactly as strict as
 * before — `high` + 0.85 is unchanged — while giving genuinely useful-but-not-critical knowledge
 * a path in.
 *
 * `supersede`/`invalidate` can never land on probation: a durable entry must only be overwritten
 * or removed by something at least as durable, or the overwrite/removal itself could silently
 * expire and resurrect the stale content it was meant to replace.
 */
export function classifyMemoryWrite(
	candidate: MemoryPromotionCandidate,
	durableThreshold = DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE,
	probationThreshold = MEMORY_PROBATION_WRITE_CONFIDENCE,
): MemoryWriteTier | undefined {
	const hasPayload = candidate.op === "invalidate" ? Boolean(candidate.targetId) : Boolean(candidate.content?.trim());
	if (!hasPayload) return undefined;
	if (candidate.necessity === "high" && candidate.confidence >= durableThreshold) return "durable";
	if (candidate.op === "add" && candidate.necessity === "medium" && candidate.confidence >= probationThreshold) {
		return "probationary";
	}
	return undefined;
}
