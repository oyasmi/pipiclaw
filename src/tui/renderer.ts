/**
 * Frontend selection for the terminal TUI: the rich pi-tui UI on a TTY, else the plain stream.
 * The contracts themselves (`TranscriptRenderer`, `Frontend`) live in `frontend.ts`.
 */
import type { SlashCommand } from "@earendil-works/pi-tui";
import type { Frontend } from "./frontend.js";
import { PiTuiFrontend } from "./pitui-frontend.js";
import { PlainFrontend } from "./plain-frontend.js";

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
	// `--print`/one-shot (interactive === false) must use the plain stream even on a
	// TTY, or the answer is trapped in a full-screen pi-tui frame and never reaches a
	// clean stdout. `--quiet` is about how much is printed, and only the plain stream can print
	// less, so it implies `--plain` rather than being silently ignored by the full-screen UI.
	if (options.plain || options.quiet || !isTty || options.interactive === false) {
		return new PlainFrontend({ quiet: options.quiet, interactive: options.interactive });
	}
	return new PiTuiFrontend({ commands: options.commands, basePath: options.basePath });
}
