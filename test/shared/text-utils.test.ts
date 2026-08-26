import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { clipText, extractAssistantText } from "../../src/shared/text-utils.js";

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
	it.each([
		[
			"head/tail strategy by default",
			"abcdefghijklmnopqrstuvwxyz",
			10,
			undefined,
			"abcd\n\n[... omitted middle section ...]\n\nuvwxyz",
		],
		[
			"a simple tail truncation when requested",
			"abcdefghijklmnopqrstuvwxyz",
			10,
			{ headRatio: 1, omitHint: "..." },
			"abcdefg...",
		],
		["unchanged text when clipping is unnecessary", "  hello  ", 10, undefined, "hello"],
	] as const)("clips with %s", (_label, text, limit, options, expected) => {
		expect(clipText(text, limit, options)).toBe(expected);
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
