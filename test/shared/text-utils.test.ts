import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	clipText,
	extractAssistantText,
	extractLabelFromArgs,
	HAN_REGEX,
	truncate,
} from "../../src/shared/text-utils.js";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("shared/text-utils", () => {
	it("clips text with a head/tail strategy by default", () => {
		const clipped = clipText("abcdefghijklmnopqrstuvwxyz", 10);
		expect(clipped).toBe("abcd\n\n[... omitted middle section ...]\n\nuvwxyz");
	});

	it("clips text as a simple tail truncation when requested", () => {
		const clipped = clipText("abcdefghijklmnopqrstuvwxyz", 10, { headRatio: 1, omitHint: "..." });
		expect(clipped).toBe("abcdefg...");
	});

	it("returns unchanged text when clipping is unnecessary", () => {
		expect(clipText("  hello  ", 10)).toBe("hello");
	});

	it("truncates long text with an ellipsis", () => {
		expect(truncate("hello world", 8)).toBe("hello...");
		expect(truncate("short", 8)).toBe("short");
	});

	it("detects Han text", () => {
		expect(HAN_REGEX.test("修复 memory bug")).toBe(true);
		expect(HAN_REGEX.test("plain ascii")).toBe(false);
	});

	it("extracts trimmed labels from tool args", () => {
		expect(extractLabelFromArgs({ label: "  review changes  " })).toBe("review changes");
		expect(extractLabelFromArgs({ label: "" })).toBeNull();
		expect(extractLabelFromArgs({})).toBeNull();
		expect(extractLabelFromArgs(null)).toBeNull();
	});

	it("extracts assistant text content and ignores non-text parts", () => {
		const message = createAssistantMessage([
			{ type: "thinking", thinking: "plan" },
			{ type: "text", text: "First line" },
			{ type: "toolCall", toolCallId: "call-1", toolName: "read", args: {} },
			{ type: "text", text: "Second line" },
		] as AssistantMessage["content"]);
		expect(extractAssistantText(message)).toBe("First line\nSecond line");
	});
});
