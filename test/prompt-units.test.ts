import { describe, expect, it } from "vitest";
import { clipTextByPromptUnits, countPromptUnits } from "../src/shared/prompt-units.js";

describe("countPromptUnits", () => {
	it("counts Latin word runs and CJK code points as units, ignoring punctuation, emoji, and extra whitespace", () => {
		expect(countPromptUnits("")).toBe(0);
		expect(countPromptUnits("hello")).toBe(1);
		expect(countPromptUnits("hello world")).toBe(2);
		expect(countPromptUnits("  spaced   out  words ")).toBe(3);
		expect(countPromptUnits("你好")).toBe(2);
		expect(countPromptUnits("こんにちは")).toBe(5);
		expect(countPromptUnits("안녕")).toBe(2);
		// "读取" (2) + "README" (1) + "文件" (2) = 5
		expect(countPromptUnits("读取 README 文件。")).toBe(5);
		expect(countPromptUnits("🎉🚀")).toBe(0);
		expect(countPromptUnits("!!! ??? ...")).toBe(0);
		expect(countPromptUnits("done ✅")).toBe(1);
	});

	it("serves URL and supplementary-plane text: dotted/slashed segments and surrogate-pair ideographs count per segment/code point", () => {
		// https, example, com, path/one → https example com path one
		expect(countPromptUnits("https://example.com/path")).toBe(4);

		// U+20000 (𠀀) is a supplementary-plane Han ideograph encoded as a surrogate pair.
		const supplementary = "𠀀";
		expect(supplementary.length).toBe(2); // two UTF-16 code units
		expect(countPromptUnits(supplementary)).toBe(1);
		expect(countPromptUnits(`${supplementary}${supplementary}`)).toBe(2);
	});
});

describe("clipTextByPromptUnits", () => {
	it("returns text within both budgets unchanged, deterministically", () => {
		const result = clipTextByPromptUnits("hello world", 10);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe("hello world");
		expect(result.rawUnits).toBe(2);
		expect(result.injectedUnits).toBe(2);

		const text = "字".repeat(400);
		const a = clipTextByPromptUnits(text, 120);
		const b = clipTextByPromptUnits(text, 120);
		expect(a.text).toBe(b.text);
		expect(a.injectedUnits).toBe(b.injectedUnits);
	});

	it("clips to the unit ceiling with head, tail, and marker preserved, and also respects a maxChars ceiling", () => {
		const words = Array.from({ length: 200 }, (_, index) => `w${index}`).join(" ");
		const result = clipTextByPromptUnits(words, 40, { marker: " [...] " });
		expect(result.truncated).toBe(true);
		expect(result.injectedUnits).toBeLessThanOrEqual(40);
		expect(result.rawUnits).toBe(200);
		expect(result.text).toContain("[...]");
		expect(result.text.startsWith("w0")).toBe(true);
		expect(result.text.trimEnd().endsWith("w199")).toBe(true);

		const cjk = "字".repeat(500); // 500 units, 500 chars
		const charCapped = clipTextByPromptUnits(cjk, 1_000, { maxChars: 100, marker: "…" });
		expect(charCapped.truncated).toBe(true);
		expect(charCapped.text.length).toBeLessThanOrEqual(100);
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

	it("keeps both ceilings even when the marker alone would exceed them", () => {
		// The contract is injectedUnits ≤ maxUnits; a marker bigger than the budget must
		// not leak through. Keep nothing rather than break the ceiling.
		const unitCapped = clipTextByPromptUnits("hello world here are many words", 3, {
			marker: "one two three four five", // 5 units > maxUnits 3
		});
		expect(unitCapped.truncated).toBe(true);
		expect(unitCapped.injectedUnits).toBeLessThanOrEqual(3);
		expect(unitCapped.text).toBe("");

		const charCapped = clipTextByPromptUnits("hello world", 100, { marker: "M".repeat(10), maxChars: 5 });
		expect(charCapped.truncated).toBe(true);
		expect(charCapped.text.length).toBeLessThanOrEqual(5);
		expect(charCapped.text).toBe("");
	});
});
