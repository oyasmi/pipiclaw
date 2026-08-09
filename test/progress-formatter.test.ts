import { describe, expect, it } from "vitest";
import { clipUserInput, extractToolResultText, formatProgressEntry } from "../src/agent/progress-formatter.js";

describe("progress formatter", () => {
	it("clips long user input with stable head and tail context", () => {
		expect(clipUserInput("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdef\n\n[... omitted 16 chars ...]\n\nwxyz");
		expect(clipUserInput(" short\r\n", 10)).toBe("short");
	});

	// The dropped middle of a pasted log is where the failure usually is; the marker has to say
	// where the rest went, not just that some of it is missing.
	it("points at the saved original when the caller persisted it", () => {
		const clipped = clipUserInput("abcdefghijklmnopqrstuvwxyz", 10, "/ws/dm_1/inbox/message-x.txt");
		expect(clipped).toContain("omitted 16 chars; the complete message is saved at /ws/dm_1/inbox/message-x.txt");
		expect(clipped).toContain("read tool");
	});

	it("formats progress entries without leaking blank or object-replacement content", () => {
		expect(formatProgressEntry("tool", "\uFFFC\nnpm test\n\n-- --run")).toBe("\u279C npm test -- --run");
		expect(formatProgressEntry("thinking", " checking state ")).toBe("\u2726 checking state");
		expect(formatProgressEntry("error", " boom ")).toBe("\u2715 boom");
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
