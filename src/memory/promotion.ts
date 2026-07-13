export type MemoryPromotionTarget = "channel-memory";
export type SkillPromotionAction = "create" | "patch" | "write_file";

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

export interface SkillPromotionCandidate {
	action: SkillPromotionAction;
	name: string;
	content?: string;
	filePath?: string;
	find?: string;
	replace?: string;
	confidence: number;
	necessity: "low" | "medium" | "high";
	reason: string;
}

export interface PostTurnReviewResult {
	memoryOps: MemoryPromotionCandidate[];
	skillCandidates: SkillPromotionCandidate[];
	discarded: Array<{ content: string; reason: string }>;
}

export const DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE = 0.85;
export const DEFAULT_SKILL_AUTO_WRITE_CONFIDENCE = 0.9;

function isHighNecessity(value: string): boolean {
	return value === "high";
}

export function shouldAutoWriteMemory(
	candidate: MemoryPromotionCandidate,
	threshold = DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE,
): boolean {
	return (
		candidate.confidence >= threshold &&
		isHighNecessity(candidate.necessity) &&
		(candidate.op === "invalidate" ? Boolean(candidate.targetId) : Boolean(candidate.content?.trim()))
	);
}

export function shouldAutoWriteSkill(
	candidate: SkillPromotionCandidate,
	threshold = DEFAULT_SKILL_AUTO_WRITE_CONFIDENCE,
): boolean {
	return candidate.confidence >= threshold && candidate.necessity === "high";
}
