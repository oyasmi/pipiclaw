import { describe, expect, it } from "vitest";
import { capReply } from "../src/agent/reply-limits.js";

describe("capReply", () => {
	it("passes short text through unchanged", () => {
		const result = capReply("short", { nextStepHint: "do X" });
		expect(result).toEqual({ text: "short", truncated: false });
	});

	it("cuts on the last newline at or before the limit, never mid-line", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`.repeat(5));
		const text = lines.join("\n");
		const result = capReply(text, { maxChars: 100, nextStepHint: "see more" });
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBeLessThan(text.length);
		// The truncated body (everything before the appended note) must be exactly whole lines.
		const [body] = result.text.split("\n\n（内容过长已截断");
		expect(lines.join("\n")).toContain(body);
	});

	it("appends the caller's next-step hint", () => {
		const result = capReply("x".repeat(2000), { nextStepHint: "用 `/foo` 查看更多" });
		expect(result.text).toContain("用 `/foo` 查看更多");
		expect(result.truncated).toBe(true);
	});
});
