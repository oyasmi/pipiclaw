export type MemoryPromotionTarget = "channel-memory";
export type SkillPromotionAction = "create" | "patch" | "write_file";

export interface MemoryPromotionCandidate {
	target: MemoryPromotionTarget;
	content: string;
	confidence: number;
	reason: string;
	necessity?: "low" | "medium" | "high";
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
	memoryCandidates: MemoryPromotionCandidate[];
	skillCandidates: SkillPromotionCandidate[];
	discarded: Array<{ content: string; reason: string }>;
}

export const DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE = 0.85;
export const DEFAULT_SKILL_AUTO_WRITE_CONFIDENCE = 0.9;

function isHighNecessity(value: string | undefined): boolean {
	return value === undefined || value === "high";
}

export function shouldAutoWriteMemory(
	candidate: MemoryPromotionCandidate,
	threshold = DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE,
): boolean {
	return (
		candidate.confidence >= threshold && isHighNecessity(candidate.necessity) && candidate.content.trim().length > 0
	);
}

export function shouldAutoWriteSkill(
	candidate: SkillPromotionCandidate,
	threshold = DEFAULT_SKILL_AUTO_WRITE_CONFIDENCE,
): boolean {
	return candidate.confidence >= threshold && candidate.necessity === "high";
}
