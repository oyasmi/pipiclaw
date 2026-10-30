import { describe, expect, it } from "vitest";
import { assembleTurnPrompt, type TurnPromptParts } from "../src/agent/turn/turn-prompt.js";

function parts(overrides: Partial<TurnPromptParts> = {}): TurnPromptParts {
	return {
		clippedInput: "ship it",
		userMessage: "[2026-08-28 10:00] [Tester]: ship it",
		preserveRawInput: false,
		channelCapsule: "<runtime_turn_context>\nChannel directory: /w/dingtalk:dm:1\n</runtime_turn_context>",
		durableMemoryBootstrap: "",
		taskDigest: "",
		...overrides,
	};
}

describe("assembleTurnPrompt", () => {
	it("orders runtime context ahead of the user message, least turn-specific block first", () => {
		const { text } = assembleTurnPrompt(
			parts({
				durableMemoryBootstrap: "<memory_bootstrap>B</memory_bootstrap>",
				taskDigest: "<task_agenda>D</task_agenda>",
			}),
		);

		expect(text).toContain("<user_message>\n[2026-08-28 10:00] [Tester]: ship it\n</user_message>");
		const positions = [
			text.indexOf("<memory_bootstrap>"),
			text.indexOf("<task_agenda>"),
			text.indexOf("<runtime_turn_context>"),
			text.indexOf("<user_message>"),
		];
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	describe("preserveRawInput", () => {
		it("forwards a parameterized command byte-for-byte and drops runtime context", () => {
			const { text, stats } = assembleTurnPrompt(
				parts({
					clippedInput: "/compact keep decisions",
					preserveRawInput: true,
					durableMemoryBootstrap: "memory",
					taskDigest: "agenda",
				}),
			);
			expect(text).toBe("/compact keep decisions");
			expect(stats.userMessageChars).toBe("/compact keep decisions".length);
			expect(stats.channelCapsuleUnits).toBeGreaterThan(0);
		});
	});
});
