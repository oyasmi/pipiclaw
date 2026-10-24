/**
 * `pipiclaw tui` CLI: argument parsing and entry. Parsing is a pure function (`parseTuiArgs`) so
 * it can be unit-tested. The terminal is a client of the Web API (spec 061, D25): it connects to
 * the daemon's socket, or — when no daemon is running — to a runtime it starts inside this
 * process (D26, `startEmbeddedRuntime`, supplied by the entry so `tui/` never imports `runtime/`).
 */
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	DEFAULT_BOOTSTRAP_PATHS,
	readCliVersion,
} from "../app/home.js";
import { PipiclawSettingsManager } from "../config/settings.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { createLink, createSocketClient, openConversation, printOnce, requireSocket } from "./client.js";
import { TUI_SLASH_COMMANDS } from "./commands.js";
import { traitsOf } from "./render.js";
import { createFrontend } from "./renderer.js";
import { TuiSession } from "./session.js";

export type ParsedTui =
	| {
			kind: "run";
			desk?: string;
			create: boolean;
			fresh: boolean;
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
	let desk: string | undefined;
	let create = false;
	let fresh = false;
	let print = false;
	let quiet = false;
	let plain = false;
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--desk") {
			desk = args[index + 1];
			if (!desk || desk.startsWith("-"))
				return { kind: "error", message: "--desk needs a name; omit it to open default." };
			index += 1;
		} else if (arg.startsWith("--desk=")) {
			desk = arg.slice("--desk=".length);
		} else if (arg === "--create") {
			create = true;
		} else if (arg === "--new") {
			fresh = true;
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

	return { kind: "run", desk, create, fresh, print, quiet, plain, positional };
}

function printTuiHelp(io: BootstrapIO): void {
	io.log("Usage: pipiclaw tui [options] [prompt]");
	io.log("");
	io.log("Chat with the pipiclaw agent in the terminal, using the same config and the");
	io.log("same assistant as the DingTalk runtime.");
	io.log("");
	io.log("The terminal is a client of the Web API's local socket. With a daemon running it");
	io.log("connects to it; otherwise it runs the runtime itself until you exit. It opens the");
	io.log("default desk and resumes this desk's last conversation, sharing the desk's memory,");
	io.log("tasks and files with the channels bound to it.");
	io.log("");
	io.log("Options:");
	io.log("  --desk <name>             Open a desk (default: default)");
	io.log("  --create                  Create the desk first (like `/desk new`)");
	io.log("  --new                     Start a new conversation instead of resuming");
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

/** A runtime this process started for the terminal. */
export interface EmbeddedRuntimeHandle {
	stop(): Promise<void>;
}

export interface TuiHooks {
	/** Start the runtime in this process, or `undefined` when a daemon already holds the app home. */
	startEmbeddedRuntime(paths: BootstrapPaths, io: BootstrapIO): Promise<EmbeddedRuntimeHandle | undefined>;
}

export async function runTui(
	argv: string[],
	hooks: TuiHooks,
	io: BootstrapIO = console,
	paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS,
): Promise<void> {
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

	// The pi-tui frontend owns stdout; the plain frontend prints only the final answer. Either way
	// the console log sink would corrupt the output, so logging goes to its file sink only.
	log.setConsoleLoggingEnabled(false);
	const embedded = await hooks.startEmbeddedRuntime(paths, io);
	try {
		if (!embedded) requireSocket(paths, io);
		try {
			await runClient(parsed, initialPrompt, paths, io);
		} catch (error) {
			if (error instanceof BootstrapExitError) throw error;
			// A refused or failed request is a message for the user, not a stack trace.
			io.error(errorMessage(error));
			throw new BootstrapExitError(1);
		}
	} finally {
		if (embedded) {
			process.stderr.write("正在关闭运行时…\n");
			await embedded.stop();
		}
	}
}

async function runClient(
	parsed: Extract<ParsedTui, { kind: "run" }>,
	initialPrompt: string | undefined,
	paths: BootstrapPaths,
	io: BootstrapIO,
): Promise<void> {
	const client = createSocketClient(paths);
	const { id, replies } = await openConversation(
		client,
		paths,
		{ desk: parsed.desk, create: parsed.create, fresh: parsed.fresh },
		io,
	);

	if (parsed.print) {
		const frontend = createFrontend({ plain: true, quiet: parsed.quiet, interactive: false });
		for (const reply of replies) frontend.showNotice(reply);
		if (initialPrompt) frontend.showFinal(await printOnce(client, id, initialPrompt));
		frontend.stop();
		return;
	}

	const frontend = createFrontend({
		plain: parsed.plain,
		quiet: parsed.quiet,
		interactive: true,
		commands: TUI_SLASH_COMMANDS,
		basePath: paths.workspaceDir,
	});
	const traits = traitsOf(new PipiclawSettingsManager(paths.appHomeDir).getTuiSettings().responseMode);
	const session = new TuiSession({
		link: createLink(client, paths, id),
		frontend,
		traits,
		label: `终端 · ${parsed.desk ?? "default"}`,
		notices: replies,
	});
	await session.startInteractive(initialPrompt);
}
