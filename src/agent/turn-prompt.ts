import { countPromptUnits } from "../shared/prompt-units.js";
import type { PromptTurnContextStats } from "./prompt/manifest.js";

export interface TurnPromptParts {
	/** The user's message, already clipped to `MAX_USER_MESSAGE_CHARS`. Measured, not rendered. */
	clippedInput: string;
	/** `clippedInput` carrying the runtime's `[time] [user]:` prefix. Unused when raw input is preserved. */
	userMessage: string;
	/**
	 * A slash command is forwarded byte-for-byte: the SDK matches it against its own command table,
	 * so a wrapper or a prepended context block would stop it from matching.
	 */
	preserveRawInput: boolean;
	/** `<runtime_turn_context>`: the channel facts kept out of the cached system prompt. */
	channelCapsule: string;
	/** `<memory_bootstrap>`: workspace memory + channel index + journal, first turn only (spec 050, D1). */
	durableMemoryBootstrap: string;
	taskDigest: string;
}

export interface AssembledTurnPrompt {
	text: string;
	stats: PromptTurnContextStats;
}

/**
 * Compose one turn's prompt from the pieces `run()` gathered, and measure what each piece cost.
 *
 * The order is a contract, not a preference: memory bootstrap → task agenda → channel capsule →
 * the user's message. Everything the runtime supplies precedes the message it is context *for*,
 * and the blocks that change least between turns come first, so the provider's prefix cache keeps
 * as long a match as possible. An empty piece contributes no separator, so a turn after the
 * bootstrap one reads exactly like one where memory is disabled.
 *
 * `stats` measures the inputs, never the rendered wrapper — it is what `/context` reports as the
 * previous turn's automatic context, and the per-piece unit caps are enforced upstream by the
 * builders themselves (`memory/index-budget.ts`, `memory/task-digest.ts`).
 */
export function assembleTurnPrompt(parts: TurnPromptParts): AssembledTurnPrompt {
	const stats: PromptTurnContextStats = {
		durableMemoryChars: parts.durableMemoryBootstrap.length,
		durableMemoryUnits: countPromptUnits(parts.durableMemoryBootstrap),
		taskDigestChars: parts.taskDigest.length,
		taskDigestUnits: countPromptUnits(parts.taskDigest),
		channelCapsuleUnits: countPromptUnits(parts.channelCapsule),
		userMessageChars: parts.clippedInput.length,
	};

	if (parts.preserveRawInput) {
		return { text: parts.clippedInput, stats };
	}

	const blocks = [
		parts.durableMemoryBootstrap,
		parts.taskDigest,
		parts.channelCapsule,
		`<user_message>\n${parts.userMessage}\n</user_message>`,
	];
	return { text: blocks.filter((block) => block !== "").join("\n\n"), stats };
}
