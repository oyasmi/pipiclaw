import { describe, expect, it } from "vitest";
import { clipUserInput, extractToolResultText, formatProgressEntry } from "../src/agent/progress-formatter.js";

describe("progress formatter", () => {
	it("clips long user input with stable head and tail context", () => {
		expect(clipUserInput("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdef\n\n[... omitted 16 chars ...]\n\nwxyz");
		expect(clipUserInput(" short\r\n", 10)).toBe("short");
	});

	it("formats progress entries without leaking blank or object-replacement content", () => {
		expect(formatProgressEntry("tool", "\uFFFC\nnpm test\n\n-- --run")).toBe("Running: npm test -- --run");
		expect(formatProgressEntry("thinking", " checking state ")).toBe("Thinking: checking state");
		expect(formatProgressEntry("error", " boom ")).toBe("Error: boom");
		expect(formatProgressEntry("assistant", " done\nnow ")).toBe("done now");
		expect(formatProgressEntry("assistant", "\uFFFC\n \r")).toBe("");
	});

	it("extracts text tool results and stringifies non-text results", () => {
		expect(extractToolResultText("plain")).toBe("plain");
		expect(
			extractToolResultText({
				content: [
					{ type: "text", text: "first" },
					{ type: "image", data: "ignored" },
					{ type: "text", text: "second" },
				],
			}),
		).toBe("first\nsecond");
		expect(extractToolResultText({ ok: true })).toBe('{"ok":true}');
		expect(extractToolResultText(undefined)).toBe("undefined");
	});
});
