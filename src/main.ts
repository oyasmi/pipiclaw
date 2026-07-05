#!/usr/bin/env node

import { bootstrap, isBootstrapExitError } from "./runtime/bootstrap.js";
import { runTui } from "./tui/cli.js";

// `pipiclaw tui [...]` starts the terminal UI; anything else is the DingTalk
// runtime, whose entry is unchanged.
const entry = process.argv[2] === "tui" ? runTui(process.argv) : bootstrap(process.argv);

void entry.catch((error: unknown) => {
	if (isBootstrapExitError(error)) {
		process.exit(error.code);
	}

	console.error(error);
	process.exit(1);
});
