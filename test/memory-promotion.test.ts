import { describe, expect, it } from "vitest";
import {
	classifyMemoryWrite,
	DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE,
	MEMORY_PROBATION_WRITE_CONFIDENCE,
	type MemoryPromotionCandidate,
} from "../src/memory/promotion.js";

// This gate decides whether the runtime writes memory entries automatically, and at which
// tier (durable vs. probationary) — a real behavior boundary (spec 037, D6). Pure and cheap to
// test, but had zero coverage before spec 009.
function memoryCandidate(overrides: Partial<MemoryPromotionCandidate> = {}): MemoryPromotionCandidate {
	return {
		target: "channel-memory",
		op: "add",
		kind: "preference",
		content: "User prefers concise replies.",
		confidence: 0.95,
		reason: "Stated explicitly twice.",
		necessity: "high",
		...overrides,
	};
}

describe("classifyMemoryWrite", () => {
	it("classifies as durable when confidence meets the default threshold and necessity is high", () => {
		expect(classifyMemoryWrite(memoryCandidate())).toBe("durable");
	});

	it("does not classify below the durable confidence threshold", () => {
		expect(
			classifyMemoryWrite(memoryCandidate({ confidence: DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE - 0.01 })),
		).toBeUndefined();
	});

	it("classifies medium necessity as probationary at or above the probation threshold", () => {
		expect(
			classifyMemoryWrite(memoryCandidate({ confidence: MEMORY_PROBATION_WRITE_CONFIDENCE, necessity: "medium" })),
		).toBe("probationary");
		expect(classifyMemoryWrite(memoryCandidate({ confidence: 1, necessity: "medium" }))).toBe("probationary");
	});

	it("rejects medium necessity below the probation threshold", () => {
		expect(
			classifyMemoryWrite(
				memoryCandidate({ confidence: MEMORY_PROBATION_WRITE_CONFIDENCE - 0.01, necessity: "medium" }),
			),
		).toBeUndefined();
	});

	it("never classifies low necessity, even at full confidence", () => {
		expect(classifyMemoryWrite(memoryCandidate({ confidence: 1, necessity: "low" }))).toBeUndefined();
	});

	it("never classifies supersede/invalidate as probationary, even at high confidence medium necessity", () => {
		expect(
			classifyMemoryWrite(
				memoryCandidate({ op: "supersede", targetId: "m-1", confidence: 0.95, necessity: "medium" }),
			),
		).toBeUndefined();
		expect(
			classifyMemoryWrite(
				memoryCandidate({ op: "invalidate", targetId: "m-1", confidence: 0.95, necessity: "medium" }),
			),
		).toBeUndefined();
	});

	it("still classifies supersede as durable at high necessity", () => {
		expect(classifyMemoryWrite(memoryCandidate({ op: "supersede", targetId: "m-1" }))).toBe("durable");
	});

	it("does not classify empty or whitespace-only content", () => {
		expect(classifyMemoryWrite(memoryCandidate({ content: "   " }))).toBeUndefined();
		expect(classifyMemoryWrite(memoryCandidate({ content: "" }))).toBeUndefined();
	});

	it("honors a custom durable threshold override", () => {
		const candidate = memoryCandidate({ confidence: 0.5 });
		expect(classifyMemoryWrite(candidate, 0.4)).toBe("durable");
		expect(classifyMemoryWrite(candidate, 0.6)).toBeUndefined();
	});

	it("honors a custom probation threshold override", () => {
		const candidate = memoryCandidate({ confidence: 0.7, necessity: "medium" });
		expect(classifyMemoryWrite(candidate, DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE, 0.6)).toBe("probationary");
		expect(classifyMemoryWrite(candidate, DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE, 0.8)).toBeUndefined();
	});
});
