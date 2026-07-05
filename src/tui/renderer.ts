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
 * for non-TTY / piped / `--print` use.
 */
import type { SlashCommand } from "@earendil-works/pi-tui";
import { PiTuiFrontend } from "./pitui-frontend.js";
import { PlainFrontend } from "./plain-frontend.js";

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

export interface FrontendOptions {
	/** Force the plain frontend even on a TTY. */
	plain?: boolean;
	/** Plain frontend only: suppress progress/notice output. */
	quiet?: boolean;
	/** Plain frontend only: false for a one-shot run where the app supplies the prompt. */
	interactive?: boolean;
	/** Slash commands offered in editor autocomplete (pi-tui frontend). */
	commands?: SlashCommand[];
	/** Base path for autocomplete (pi-tui frontend). */
	basePath?: string;
}

/**
 * Pick a frontend: the rich pi-tui UI on a real TTY, else the plain stream
 * (piped stdin/stdout, redirected output, or `--print`).
 */
export function createFrontend(options: FrontendOptions = {}): Frontend {
	const isTty = process.stdout.isTTY === true && process.stdin.isTTY === true;
	if (options.plain || !isTty) {
		return new PlainFrontend({ quiet: options.quiet, interactive: options.interactive });
	}
	return new PiTuiFrontend({ commands: options.commands, basePath: options.basePath });
}
