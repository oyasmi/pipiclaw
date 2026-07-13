import { describe, expect, it } from "vitest";
import {
	DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE,
	DEFAULT_SKILL_AUTO_WRITE_CONFIDENCE,
	type MemoryPromotionCandidate,
	type SkillPromotionCandidate,
	shouldAutoWriteMemory,
	shouldAutoWriteSkill,
} from "../src/memory/promotion.js";

// These two gates decide whether the runtime writes memory/skill files
// automatically, without an explicit user confirmation — a real behavior
// boundary (AGENTS.md's promotion rules: repeated errors/patterns graduate
// into memory/SOP/skills). Pure and cheap to test, but had zero coverage.
function memoryCandidate(overrides: Partial<MemoryPromotionCandidate> = {}): MemoryPromotionCandidate {
	return {
		target: "channel-memory",
		op: "add",
		content: "User prefers concise replies.",
		confidence: 0.95,
		reason: "Stated explicitly twice.",
		necessity: "high",
		...overrides,
	};
}

function skillCandidate(overrides: Partial<SkillPromotionCandidate> = {}): SkillPromotionCandidate {
	return {
		action: "create",
		name: "weekly-report",
		content: "# Weekly report skill",
		confidence: 0.95,
		necessity: "high",
		reason: "Repeated 5 times.",
		...overrides,
	};
}

describe("shouldAutoWriteMemory", () => {
	it("auto-writes when confidence meets the default threshold and necessity is high", () => {
		expect(shouldAutoWriteMemory(memoryCandidate())).toBe(true);
	});

	it("does not auto-write below the confidence threshold", () => {
		expect(shouldAutoWriteMemory(memoryCandidate({ confidence: DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE - 0.01 }))).toBe(
			false,
		);
	});

	it("does not auto-write when necessity is not high, even at full confidence", () => {
		expect(shouldAutoWriteMemory(memoryCandidate({ confidence: 1, necessity: "medium" }))).toBe(false);
		expect(shouldAutoWriteMemory(memoryCandidate({ confidence: 1, necessity: "low" }))).toBe(false);
	});

	it("does not auto-write empty or whitespace-only content", () => {
		expect(shouldAutoWriteMemory(memoryCandidate({ content: "   " }))).toBe(false);
		expect(shouldAutoWriteMemory(memoryCandidate({ content: "" }))).toBe(false);
	});

	it("honors a custom threshold override", () => {
		const candidate = memoryCandidate({ confidence: 0.5 });
		expect(shouldAutoWriteMemory(candidate, 0.4)).toBe(true);
		expect(shouldAutoWriteMemory(candidate, 0.6)).toBe(false);
	});
});

describe("shouldAutoWriteSkill", () => {
	it("auto-writes when confidence meets the default threshold and necessity is high", () => {
		expect(shouldAutoWriteSkill(skillCandidate())).toBe(true);
	});

	it("does not auto-write below the confidence threshold", () => {
		expect(shouldAutoWriteSkill(skillCandidate({ confidence: DEFAULT_SKILL_AUTO_WRITE_CONFIDENCE - 0.01 }))).toBe(
			false,
		);
	});

	it("does not auto-write when necessity is not high", () => {
		expect(shouldAutoWriteSkill(skillCandidate({ confidence: 1, necessity: "medium" }))).toBe(false);
	});

	it("honors a custom threshold override", () => {
		const candidate = skillCandidate({ confidence: 0.5 });
		expect(shouldAutoWriteSkill(candidate, 0.4)).toBe(true);
		expect(shouldAutoWriteSkill(candidate, 0.6)).toBe(false);
	});
});
