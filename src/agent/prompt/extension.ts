/**
 * Final-boundary extension (spec 025 §6.11, §10.6).
 *
 * pi always appends its own tail — skills, current date, cwd — after a custom
 * system prompt, so the last thing the model would otherwise read is
 * user-authored content. This extension runs at `before_agent_start`, the only
 * seam that sees the fully assembled prompt, and appends the runtime boundary
 * footer after it. It is a pure function of the prompt pi built: same input,
 * same bytes, so the provider-side cache prefix is unaffected.
 *
 * The callback also hands the runner the prompt that is actually sent, so
 * `/context` and the debug manifest report the real thing rather than a stale
 * base prompt. Replace this with an SDK renderer seam once pi grows one.
 */

import type { BeforeAgentStartEvent, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export interface PromptBoundaryExtensionOptions {
	/** The footer text; empty disables the append (the prompt is still reported). */
	getFooter: () => string;
	/** Receives the exact system prompt handed to the provider for this turn. */
	onFinalPrompt?: (systemPrompt: string) => void;
}

export function createPromptBoundaryExtension(options: PromptBoundaryExtensionOptions): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
			const footer = options.getFooter().trim();
			const systemPrompt = footer ? `${event.systemPrompt.trimEnd()}\n\n${footer}\n` : event.systemPrompt;
			options.onFinalPrompt?.(systemPrompt);
			return { systemPrompt };
		});
	};
}
