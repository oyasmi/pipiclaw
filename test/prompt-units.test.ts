import { describe, expect, it } from "vitest";
import { clipTextByPromptUnits, countPromptUnits } from "../src/shared/prompt-units.js";

describe("countPromptUnits", () => {
	it("counts each non-CJK word run as one unit", () => {
		expect(countPromptUnits("")).toBe(0);
		expect(countPromptUnits("hello")).toBe(1);
		expect(countPromptUnits("hello world")).toBe(2);
		expect(countPromptUnits("  spaced   out  words ")).toBe(3);
	});

	it("counts each CJK code point as its own unit", () => {
		expect(countPromptUnits("你好")).toBe(2);
		expect(countPromptUnits("こんにちは")).toBe(5);
		expect(countPromptUnits("안녕")).toBe(2);
	});

	it("mixes CJK and Latin, ignoring punctuation and whitespace", () => {
		// "读取" (2) + "README" (1) + "文件" (2) = 5
		expect(countPromptUnits("读取 README 文件。")).toBe(5);
	});

	it("does not count emoji or punctuation as units", () => {
		expect(countPromptUnits("🎉🚀")).toBe(0);
		expect(countPromptUnits("!!! ??? ...")).toBe(0);
		expect(countPromptUnits("done ✅")).toBe(1);
	});

	it("treats a URL as its dotted/slashed word segments", () => {
		// https, example, com, path/one, → https example com path one
		expect(countPromptUnits("https://example.com/path")).toBe(4);
	});

	it("counts a surrogate-pair CJK character as a single unit", () => {
		// U+20000 (𠀀) is a supplementary-plane Han ideograph encoded as a surrogate pair.
		const supplementary = "𠀀";
		expect(supplementary.length).toBe(2); // two UTF-16 code units
		expect(countPromptUnits(supplementary)).toBe(1);
		expect(countPromptUnits(`${supplementary}${supplementary}`)).toBe(2);
	});
});

describe("clipTextByPromptUnits", () => {
	it("returns the text unchanged when within both budgets", () => {
		const result = clipTextByPromptUnits("hello world", 10);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("hello world");
		expect(result.rawUnits).toBe(2);
		expect(result.injectedUnits).toBe(2);
	});

	it("clips to at most maxUnits, marker included, head and tail preserved", () => {
		const words = Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ");
		const result = clipTextByPromptUnits(words, 40, { marker: " [...] " });
		expect(result.truncated).toBe(true);
		expect(result.injectedUnits).toBeLessThanOrEqual(40);
		expect(result.rawUnits).toBe(200);
		expect(result.text).toContain("[...]");
		expect(result.text.startsWith("w0")).toBe(true);
		expect(result.text.trimEnd().endsWith("w199")).toBe(true);
	});

	it("also respects a maxChars ceiling", () => {
		const cjk = "字".repeat(500); // 500 units, 500 chars
		const result = clipTextByPromptUnits(cjk, 1_000, { maxChars: 100, marker: "…" });
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(100);
	});

	it("is deterministic for the same input", () => {
		const text = "字".repeat(400);
		const a = clipTextByPromptUnits(text, 120);
		const b = clipTextByPromptUnits(text, 120);
		expect(a.text).toBe(b.text);
		expect(a.injectedUnits).toBe(b.injectedUnits);
	});

	it("never splits a surrogate pair at the cut point", () => {
		const supplementary = "𠀀"; // one Han ideograph, two UTF-16 code units, one unit
		const text = supplementary.repeat(300); // 300 units
		const result = clipTextByPromptUnits(text, 60, { marker: "|" });
		expect(result.truncated).toBe(true);
		// A split surrogate would leave a lone \uD840/\uDC00; the string must round-trip cleanly.
		expect(result.text).toBe(Array.from(result.text).join(""));
		expect(result.text).not.toContain("�");
	});

	it("still honors maxUnits when the marker alone would exceed it", () => {
		// The contract is injectedUnits ≤ maxUnits; a marker bigger than the budget must
		// not leak through. Keep nothing rather than break the ceiling.
		const result = clipTextByPromptUnits("hello world here are many words", 3, {
			marker: "one two three four five", // 5 units > maxUnits 3
		});
		expect(result.truncated).toBe(true);
		expect(result.injectedUnits).toBeLessThanOrEqual(3);
		expect(result.text).toBe("");
	});

	it("still honors maxChars when the marker alone would exceed it", () => {
		const result = clipTextByPromptUnits("hello world", 100, { marker: "M".repeat(10), maxChars: 5 });
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThanOrEqual(5);
		expect(result.text).toBe("");
	});
});
