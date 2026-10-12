/**
 * Rendering + input contracts for the terminal TUI.
 *
 * `TranscriptRenderer` is the output-only surface the delivery controller
 * (`terminal-context.ts`) writes to — progress, final answers, notices. It is
 * deliberately small so it is trivial to fake in tests.
 *
 * `Frontend` is the full interactive shell the app drives: a `TranscriptRenderer`
 * plus input events and lifecycle. Two implementations exist — a pi-tui rich UI
 * (`pitui-frontend.ts`) and a plain stdout/readline fallback (`plain-frontend.ts`)
 * for non-TTY / piped / `--print` use; `renderer.ts` picks between them.
 */

export interface TranscriptRenderer {
	/** A streamed progress line (tool call, thinking, assistant increment, error). */
	appendProgress(text: string): void;
	/** The final answer for a turn, rendered prominently (Markdown where supported). */
	showFinal(markdown: string): void;
	/** A side notice (skill change, model fallback), rendered subtly. */
	showNotice(text: string): void;
	/** Collapse the current turn's progress region (used before a replacing final / silence). */
	clearProgress(): void;
	/** Toggle the working indicator (spinner). */
	setWorking(on: boolean): void;
}

export interface FrontendCallbacks {
	/** User submitted a line of input. */
	onSubmit(text: string): void;
	/** User pressed the interrupt key (Ctrl-C). Two-stage policy lives in the app. */
	onInterrupt(): void;
	/** End of input (Ctrl-D on an empty line, or stdin closed). */
	onEof(): void;
}

export interface Frontend extends TranscriptRenderer {
	/** Begin surfacing input events. Non-blocking. */
	start(callbacks: FrontendCallbacks): void;
	/** Update the status line (model, context %, hints). */
	setStatus(text: string): void;
	/** Mark a turn in-flight: disable input echo of a new turn and show the spinner. */
	setBusy(busy: boolean): void;
	/** Show a one-time welcome banner at startup. */
	showBanner(text: string): void;
	/** Tear down: restore the terminal, stop reading input. */
	stop(): void;
}
