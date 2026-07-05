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

if (process.argv[2] === "tui") {
	// The TUI resolves when the user exits (Ctrl-C / Ctrl-D / /exit) or a one-shot
	// --print finishes. Exit explicitly: raw-mode stdin and the runner session
	// keep the event loop alive, so the process would otherwise hang after the UI
	// tears down.
	runTui(process.argv).then(() => process.exit(0), handleError);
} else {
	// The DingTalk runtime is a long-lived daemon; it does not resolve, so there
	// is no success path to exit on — only surface fatal errors.
	bootstrap(process.argv).catch(handleError);
}
