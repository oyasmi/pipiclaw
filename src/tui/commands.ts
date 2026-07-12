/**
 * TUI command dispatch.
 *
 * Transport-layer commands (`/help /stop /steer /followup /status /usage
 * /events`, plus the TUI-only `/exit`) are handled locally and never reach the
 * runner. Everything else — session commands (`/model /new /compact /session`)
 * and plain messages — becomes a `run` intent; the SDK command extension handles
 * session commands inside the turn (results are delivered back through the
 * channel context), so the TUI gets them for free.
 *
 * `dispatch` is pure over its injected deps: it returns an intent the app acts
 * on, and renders info-command text via the deps. Steer/followup semantics
 * depend on whether a turn is running, which only the app knows — so those come
 * back as intents rather than being applied here.
 */
import { BUILT_IN_COMMANDS, type CommandSpec, parseBuiltInCommand, SESSION_COMMANDS } from "../agent/commands.js";

export type DispatchOutcome =
	/** Text to show the user immediately (help/status/usage/events output, or a hint). */
	| { kind: "reply"; text: string }
	/** Send this text to the runner as a normal turn. */
	| { kind: "run"; text: string }
	/** Steer the in-flight turn (app falls back to `run` when idle). */
	| { kind: "steer"; text: string }
	/** Queue this to run after the current turn (app runs it now when idle). */
	| { kind: "followup"; text: string }
	/** Abort the in-flight turn. */
	| { kind: "stop" }
	/** Leave the TUI. */
	| { kind: "exit" }
	/** Nothing to do; optional hint to show. */
	| { kind: "noop"; text?: string };

export interface DispatchDeps {
	renderHelp(): string;
	renderStatus(): string;
	renderContext(args: string): string;
	renderUsage(args: string): string;
	runEvents(args: string): Promise<string>;
	runTasks(args: string): Promise<string>;
}

export async function dispatch(input: string, deps: DispatchDeps): Promise<DispatchOutcome> {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "noop" };

	const lower = trimmed.toLowerCase();
	if (lower === "/exit" || lower === "/quit") return { kind: "exit" };

	const command = parseBuiltInCommand(trimmed);
	if (!command) {
		// Session commands (/model, /new, /compact, /session) and plain messages.
		return { kind: "run", text: input };
	}

	switch (command.name) {
		case "help":
			return { kind: "reply", text: deps.renderHelp() };
		case "status":
			return { kind: "reply", text: deps.renderStatus() };
		case "context":
			return { kind: "reply", text: deps.renderContext(command.args) };
		case "usage":
			return { kind: "reply", text: deps.renderUsage(command.args) };
		case "events":
			return { kind: "reply", text: await deps.runEvents(command.args) };
		case "tasks":
			return { kind: "reply", text: await deps.runTasks(command.args) };
		case "stop":
			return { kind: "stop" };
		case "steer":
			return command.args.trim()
				? { kind: "steer", text: command.args }
				: { kind: "noop", text: "/steer requires a message." };
		case "followup":
			return command.args.trim()
				? { kind: "followup", text: command.args }
				: { kind: "noop", text: "/followup requires a message." };
	}
}

function toAutocompleteEntry(spec: CommandSpec): { name: string; description: string; argumentHint?: string } {
	return { name: spec.name, description: spec.description, argumentHint: spec.argumentHint };
}

/**
 * Slash commands offered in editor autocomplete: transport + session (both
 * derived from the shared command tables) plus the TUI-only `/exit`.
 */
export const TUI_SLASH_COMMANDS: Array<{ name: string; description: string; argumentHint?: string }> = [
	...BUILT_IN_COMMANDS.map(toAutocompleteEntry),
	...SESSION_COMMANDS.map(toAutocompleteEntry),
	{ name: "exit", description: "Leave the TUI" },
];
