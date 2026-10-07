import { describe, expect, it } from "vitest";
import { assembleTurnPrompt, type TurnPromptParts } from "../src/agent/turn-prompt.js";

function parts(overrides: Partial<TurnPromptParts> = {}): TurnPromptParts {
	return {
		clippedInput: "ship it",
		userMessage: "[2026-08-28 10:00] [Tester]: ship it",
		preserveRawInput: false,
		channelCapsule: "<runtime_turn_context>\nChannel directory: /w/dm_1\n</runtime_turn_context>",
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

		const positions = [
			text.indexOf("<memory_bootstrap>"),
			text.indexOf("<task_agenda>"),
			text.indexOf("<runtime_turn_context>"),
			text.indexOf("<user_message>"),
		];
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it("wraps the prefixed user message, not the raw input", () => {
		const { text } = assembleTurnPrompt(parts());
		expect(text).toContain("<user_message>\n[2026-08-28 10:00] [Tester]: ship it\n</user_message>");
	});

	describe("preserveRawInput", () => {
		it("forwards a parameterized command byte-for-byte and drops runtime context", () => {
			const { text } = assembleTurnPrompt(
				parts({
					clippedInput: "/compact keep decisions",
					preserveRawInput: true,
					durableMemoryBootstrap: "memory",
					taskDigest: "agenda",
				}),
			);
			expect(text).toBe("/compact keep decisions");
		});
	});

	describe("stats", () => {
		it("measures the inputs, counting the raw input rather than the prefixed message", () => {
			const { stats } = assembleTurnPrompt(
				parts({
					clippedInput: "ship it",
					userMessage: "[2026-08-28 10:00] [Tester]: ship it",
					durableMemoryBootstrap: "记忆 abc",
					taskDigest: "<task_agenda>D</task_agenda>",
				}),
			);

			expect(stats.userMessageChars).toBe("ship it".length);
			expect(stats.taskDigestChars).toBe("<task_agenda>D</task_agenda>".length);
			expect(stats.durableMemoryChars).toBe(6);
			expect(stats.durableMemoryUnits).toBe(3);
		});

		it("still measures the pieces it was given when raw input is preserved", () => {
			const { stats } = assembleTurnPrompt(parts({ clippedInput: "/status", preserveRawInput: true }));
			expect(stats.userMessageChars).toBe("/status".length);
			expect(stats.channelCapsuleUnits).toBeGreaterThan(0);
		});
	});
});
