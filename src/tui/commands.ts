/**
 * What the terminal does with a line of input. Only `/exit`, `/quit`, `/stop`, `/steer` and
 * `/followup` mean something to the terminal itself — they are about this connection and its
 * turn. Every other line, slash command or not, goes to the server as the next message, which is
 * the one place that knows what a command means (spec 061, D25).
 */
import {
	BUILT_IN_COMMANDS,
	type CommandSpec,
	formatMissingQueueMessage,
	parseBuiltInCommand,
	SESSION_COMMANDS,
} from "../commands/catalog.js";

export type Intent =
	| { kind: "send"; text: string }
	| { kind: "steer"; text: string }
	| { kind: "followup"; text: string }
	| { kind: "stop" }
	| { kind: "exit" }
	| { kind: "noop"; hint?: string };

export function interpret(input: string): Intent {
	const trimmed = input.trim();
	if (!trimmed) return { kind: "noop" };
	const lower = trimmed.toLowerCase();
	if (lower === "/exit" || lower === "/quit") return { kind: "exit" };

	const command = parseBuiltInCommand(trimmed);
	switch (command?.name) {
		case "stop":
			return { kind: "stop" };
		case "steer":
			return command.args.trim()
				? { kind: "steer", text: command.args }
				: { kind: "noop", hint: formatMissingQueueMessage("steer") };
		case "followup":
			return command.args.trim()
				? { kind: "followup", text: command.args }
				: { kind: "noop", hint: formatMissingQueueMessage("followup") };
		default:
			return { kind: "send", text: input };
	}
}

const toAutocompleteEntry = (spec: CommandSpec) => ({
	name: spec.name,
	description: spec.description,
	argumentHint: spec.argumentHint,
});

/** Slash commands offered in editor autocomplete: the server's, plus the terminal's own `/exit`. */
export const TUI_SLASH_COMMANDS: Array<{ name: string; description: string; argumentHint?: string }> = [
	...BUILT_IN_COMMANDS.map(toAutocompleteEntry),
	...SESSION_COMMANDS.map(toAutocompleteEntry),
	{ name: "exit", description: "退出终端界面" },
];
