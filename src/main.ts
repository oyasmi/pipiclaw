#!/usr/bin/env node

import { bootstrap, isBootstrapExitError } from "./bootstrap.js";

void bootstrap(process.argv).catch((error: unknown) => {
	if (isBootstrapExitError(error)) {
		process.exit(error.code);
	}

	console.error(error);
	process.exit(1);
});
