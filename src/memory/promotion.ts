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

export function shouldAutoWriteMemory(
	candidate: MemoryPromotionCandidate,
	threshold = DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE,
): boolean {
	return (
		candidate.confidence >= threshold &&
		candidate.necessity === "high" &&
		(candidate.op === "invalidate" ? Boolean(candidate.targetId) : Boolean(candidate.content?.trim()))
	);
}
