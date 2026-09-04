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

	it("emits no separator for an omitted block", () => {
		const { text } = assembleTurnPrompt(parts({ durableMemoryBootstrap: "" }));
		expect(text).not.toMatch(/\n{3,}/);
		expect(text).toBe(`${parts().channelCapsule}\n\n<user_message>\n${parts().userMessage}\n</user_message>`);
	});

	it("joins every present block with exactly one blank line", () => {
		const { text } = assembleTurnPrompt(parts({ durableMemoryBootstrap: "B", taskDigest: "D" }));
		expect(text.startsWith("B\n\nD\n\n<runtime_turn_context>")).toBe(true);
		expect(text).not.toMatch(/\n{3,}/);
	});

	describe("preserveRawInput", () => {
		it("forwards the input byte-for-byte so the SDK's command table still matches", () => {
			const { text } = assembleTurnPrompt(parts({ clippedInput: "/compact keep decisions", preserveRawInput: true }));
			expect(text).toBe("/compact keep decisions");
		});

		it("drops every runtime block rather than prepending context a command cannot carry", () => {
			const { text } = assembleTurnPrompt(
				parts({
					clippedInput: "/model",
					preserveRawInput: true,
					durableMemoryBootstrap: "<memory_bootstrap>B</memory_bootstrap>",
					taskDigest: "<task_agenda>D</task_agenda>",
				}),
			);
			expect(text).toBe("/model");
		});
	});

	describe("stats", () => {
		it("measures the inputs, counting the raw input rather than the prefixed message", () => {
			const { stats } = assembleTurnPrompt(
				parts({
					clippedInput: "ship it",
					userMessage: "[2026-08-28 10:00] [Tester]: ship it",
					taskDigest: "<task_agenda>D</task_agenda>",
				}),
			);

			expect(stats.userMessageChars).toBe("ship it".length);
			expect(stats.taskDigestChars).toBe("<task_agenda>D</task_agenda>".length);
			expect(stats.durableMemoryChars).toBe(0);
		});

		it("reports units separately from chars, since only units are budgeted", () => {
			const { stats } = assembleTurnPrompt(parts({ durableMemoryBootstrap: "记忆条目" }));
			// Each Han code point is its own unit.
			expect(stats.durableMemoryChars).toBe(4);
			expect(stats.durableMemoryUnits).toBe(4);
		});

		it("still measures the pieces it was given when raw input is preserved", () => {
			const { stats } = assembleTurnPrompt(parts({ clippedInput: "/status", preserveRawInput: true }));
			expect(stats.userMessageChars).toBe("/status".length);
			expect(stats.channelCapsuleUnits).toBeGreaterThan(0);
		});
	});
});
