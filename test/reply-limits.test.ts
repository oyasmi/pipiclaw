import { describe, expect, it } from "vitest";
import { capReply } from "../src/commands/reply-limits.js";

describe("capReply", () => {
	it("passes short text through and cuts long text on a whole line with the next-step hint appended", () => {
		expect(capReply("short", { nextStepHint: "do X" })).toEqual({ text: "short", truncated: false });

		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`.repeat(5));
		const text = lines.join("\n");
		const result = capReply(text, { maxChars: 100, nextStepHint: "see more" });
		expect(result.truncated).toBe(true);
		// The truncated body (everything before the appended note) must be exactly whole lines.
		const [body] = result.text.split("\n\n（内容过长已截断");
		expect(lines.join("\n")).toContain(body);
	});
});
