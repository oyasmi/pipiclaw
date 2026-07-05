/**
 * `pipiclaw tui` CLI: argument parsing and entry. Parsing is a pure function
 * (`parseTuiArgs`) so it can be unit-tested; `runTui` wires it to `runTuiApp`.
 */
import { BootstrapExitError, type BootstrapIO, readCliVersion } from "../runtime/bootstrap.js";
import { parseSandboxArg, type SandboxConfig, SandboxConfigError } from "../sandbox.js";
import { runTuiApp } from "./app.js";

export type ParsedTui =
	| {
			kind: "run";
			channel?: string;
			sandbox: SandboxConfig;
			print: boolean;
			quiet: boolean;
			plain: boolean;
			positional: string[];
	  }
	| { kind: "help" }
	| { kind: "version" };

/** Parse `pipiclaw tui` arguments (everything after the `tui` subcommand). */
export function parseTuiArgs(args: string[]): ParsedTui {
	let channel: string | undefined;
	let sandbox: SandboxConfig = { type: "host" };
	let print = false;
	let quiet = false;
	let plain = false;
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--channel") {
			channel = args[index + 1];
			index += 1;
		} else if (arg.startsWith("--channel=")) {
			channel = arg.slice("--channel=".length);
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[index + 1] ?? "");
			index += 1;
		} else if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
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
		} else {
			positional.push(arg);
		}
	}

	return { kind: "run", channel, sandbox, print, quiet, plain, positional };
}

function printTuiHelp(io: BootstrapIO): void {
	io.log("Usage: pipiclaw tui [options] [prompt]");
	io.log("");
	io.log("Chat with the pipiclaw agent in the terminal, reusing the same config,");
	io.log("memory and session as the DingTalk runtime.");
	io.log("");
	io.log("Options:");
	io.log("  --channel <id>            Channel to attach to (default: tui_local).");
	io.log("                            Use dm_<staffId> to share a DingTalk conversation's memory.");
	io.log("  --sandbox=host            Run tools on host (default)");
	io.log("  --sandbox=docker:<name>   Run tools in a Docker container");
	io.log("  --print, -p               One-shot: run [prompt] (or stdin), print the answer, exit");
	io.log("  --quiet, -q               Plain mode: print only the final answer");
	io.log("  --plain                   Force the plain frontend (no full-screen UI)");
	io.log("  --version                 Print the version and exit");
	io.log("");
	io.log("Note: do not attach --channel to a DingTalk conversation the daemon is actively serving.");
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export async function runTui(argv: string[], io: BootstrapIO = console): Promise<void> {
	let parsed: ParsedTui;
	try {
		parsed = parseTuiArgs(argv.slice(3));
	} catch (err) {
		if (err instanceof SandboxConfigError) {
			io.error(`Error: ${err.message}`);
			throw new BootstrapExitError(1);
		}
		throw err;
	}

	if (parsed.kind === "help") {
		printTuiHelp(io);
		return;
	}
	if (parsed.kind === "version") {
		io.log(readCliVersion());
		return;
	}

	let initialPrompt = parsed.positional.join(" ").trim() || undefined;
	if (parsed.print && !initialPrompt && process.stdin.isTTY !== true) {
		initialPrompt = (await readStdin()).trim() || undefined;
	}

	await runTuiApp({
		sandbox: parsed.sandbox,
		channel: parsed.channel,
		print: parsed.print,
		quiet: parsed.quiet,
		plain: parsed.plain,
		initialPrompt,
		io,
	});
}
