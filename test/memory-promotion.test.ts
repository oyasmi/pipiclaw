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
	it.each([
		{
			label: "durable when confidence meets the default threshold and necessity is high",
			overrides: {},
			expected: "durable",
		},
		{
			label: "undefined below the durable confidence threshold",
			overrides: { confidence: DEFAULT_MEMORY_AUTO_WRITE_CONFIDENCE - 0.01 },
			expected: undefined,
		},
		{
			label: "probationary for medium necessity at the probation threshold",
			overrides: { confidence: MEMORY_PROBATION_WRITE_CONFIDENCE, necessity: "medium" },
			expected: "probationary",
		},
		{
			label: "probationary for medium necessity at full confidence",
			overrides: { confidence: 1, necessity: "medium" },
			expected: "probationary",
		},
		{
			label: "undefined for medium necessity below the probation threshold",
			overrides: { confidence: MEMORY_PROBATION_WRITE_CONFIDENCE - 0.01, necessity: "medium" },
			expected: undefined,
		},
		{
			label: "undefined for low necessity, even at full confidence",
			overrides: { confidence: 1, necessity: "low" },
			expected: undefined,
		},
		{
			label: "undefined for supersede at high confidence medium necessity (never probationary)",
			overrides: { op: "supersede", targetId: "m-1", confidence: 0.95, necessity: "medium" },
			expected: undefined,
		},
		{
			label: "undefined for invalidate at high confidence medium necessity (never probationary)",
			overrides: { op: "invalidate", targetId: "m-1", confidence: 0.95, necessity: "medium" },
			expected: undefined,
		},
		{
			label: "durable for supersede at high necessity",
			overrides: { op: "supersede", targetId: "m-1" },
			expected: "durable",
		},
		{
			label: "undefined for whitespace-only content",
			overrides: { content: "   " },
			expected: undefined,
		},
		{
			label: "undefined for empty content",
			overrides: { content: "" },
			expected: undefined,
		},
	])("classifies as $expected: $label", ({ overrides, expected }) => {
		expect(classifyMemoryWrite(memoryCandidate(overrides as Partial<MemoryPromotionCandidate>))).toBe(expected);
	});

	// Production-wired: consolidation.ts passes the settings-configured minAutoWriteConfidence
	// as this override, so a broken override here would silently detach the setting from behavior.
	it("honors a custom durable threshold override", () => {
		const candidate = memoryCandidate({ confidence: 0.5 });
		expect(classifyMemoryWrite(candidate, 0.4)).toBe("durable");
		expect(classifyMemoryWrite(candidate, 0.6)).toBeUndefined();
	});
});
