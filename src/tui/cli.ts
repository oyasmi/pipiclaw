/**
 * `pipiclaw tui` CLI: argument parsing and entry. Parsing is a pure function
 * (`parseTuiArgs`) so it can be unit-tested; `runTui` wires it to `runTuiApp`.
 */
import { BootstrapExitError, type BootstrapIO, readCliVersion } from "../app/home.js";
import { runTuiApp } from "./app.js";

export type ParsedTui =
	| {
			kind: "run";
			dot?: string;
			create: boolean;
			print: boolean;
			quiet: boolean;
			plain: boolean;
			positional: string[];
	  }
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "error"; message: string };

/** Parse `pipiclaw tui` arguments (everything after the `tui` subcommand). */
export function parseTuiArgs(args: string[]): ParsedTui {
	let dot: string | undefined;
	let create = false;
	let print = false;
	let quiet = false;
	let plain = false;
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--dot") {
			dot = args[index + 1];
			index += 1;
		} else if (arg.startsWith("--dot=")) {
			dot = arg.slice("--dot=".length);
		} else if (arg === "--create") {
			create = true;
		} else if (arg === "--channel" || arg.startsWith("--channel=")) {
			return { kind: "error", message: "--channel was replaced by --dot <name> (spec 058)." };
		} else if (arg === "--print" || arg === "-p") {
			print = true;
		} else if (arg === "--quiet" || arg === "-q") {
			quiet = true;
		} else if (arg === "--plain") {
			plain = true;
		} else if (arg === "--help" || arg === "-h") {
			return { kind: "help" };
		} else if (arg === "--version") {
			return { kind: "version" };
		} else if (arg.startsWith("--")) {
			// An unknown long option is a typo, not part of the prompt — reject it
			// instead of silently sending `--pritn` to the model as prompt text.
			return { kind: "error", message: `Unknown option: ${arg}` };
		} else {
			positional.push(arg);
		}
	}

	return { kind: "run", dot, create, print, quiet, plain, positional };
}

function printTuiHelp(io: BootstrapIO): void {
	io.log("Usage: pipiclaw tui [options] [prompt]");
	io.log("");
	io.log("Chat with the pipiclaw agent in the terminal, reusing the same config,");
	io.log("memory and session as the DingTalk runtime.");
	io.log("");
	io.log("The terminal opens one dot: its memory, tasks, events and files are the same");
	io.log("ones its DingTalk channels use, while the terminal keeps its own conversation,");
	io.log("which resumes automatically next time. A dot can be open here while the daemon");
	io.log("serves it; only one terminal at a time per dot.");
	io.log("");
	io.log("Options:");
	io.log("  --dot <name>              The dot to open (required)");
	io.log("  --create                  Create the dot if it does not exist");
	io.log("  --print, -p               One-shot: run [prompt] (or stdin), print the answer, exit");
	io.log("  --plain                   Use the line-based frontend instead of the full-screen UI");
	io.log("  --quiet, -q               Print only the final answer, no progress (implies --plain)");
	io.log("  --version                 Print the version and exit");
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function runTui(argv: string[], io: BootstrapIO = console): Promise<void> {
	const parsed = parseTuiArgs(argv.slice(3));

	if (parsed.kind === "help") {
		printTuiHelp(io);
		return;
	}
	if (parsed.kind === "version") {
		io.log(readCliVersion());
		return;
	}
	if (parsed.kind === "error") {
		io.error(parsed.message);
		io.error(`Run \`pipiclaw tui --help\` for usage.`);
		throw new BootstrapExitError(1);
	}

	let initialPrompt = parsed.positional.join(" ").trim() || undefined;
	if (parsed.print && !initialPrompt && process.stdin.isTTY !== true) {
		initialPrompt = (await readStdin()).trim() || undefined;
	}

	await runTuiApp({
		dot: parsed.dot,
		create: parsed.create,
		print: parsed.print,
		quiet: parsed.quiet,
		plain: parsed.plain,
		initialPrompt,
		io,
	});
}
