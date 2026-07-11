#!/usr/bin/env node

import { bootstrap, isBootstrapExitError } from "./runtime/bootstrap.js";
import { runTui } from "./tui/cli.js";

function handleError(error: unknown): never {
	if (isBootstrapExitError(error)) {
		process.exit(error.code);
	}
	console.error(error);
	process.exit(1);
}

const command = process.argv[2];

if (command === "tui") {
	// The TUI resolves when the user exits (Ctrl-C / Ctrl-D / /exit) or a one-shot
	// --print finishes. Exit explicitly: raw-mode stdin and the runner session
	// keep the event loop alive, so the process would otherwise hang after the UI
	// tears down.
	runTui(process.argv).then(() => process.exit(0), handleError);
} else if (command === undefined || command === "run" || command.startsWith("-")) {
	// Default mode: the long-lived DingTalk daemon. `run` names it explicitly;
	// a bare `pipiclaw` still runs it, and leading flags (--version/--help) are
	// handled by bootstrap's parseArgs. The daemon does not resolve, so there is
	// no success path to exit on — only surface fatal errors.
	bootstrap(process.argv).catch(handleError);
} else {
	console.error(`Unknown command: ${command}`);
	console.error("Usage: pipiclaw [run] [options]         Run the DingTalk daemon (default)");
	console.error("       pipiclaw tui [options] [prompt]   Chat with the agent in the terminal");
	console.error("Run `pipiclaw --help` for options.");
	process.exit(1);
}
