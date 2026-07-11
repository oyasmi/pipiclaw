#!/usr/bin/env node
// agentmux-idle.mjs — wake the agent when a delegated agentmux instance is done.
//
// exit 0 (wake)   when the instance is idle / exited / lost, or on any error (fail-open).
// exit 1 (silent) only when the instance is clearly still busy.
// Usage: node agentmux-idle.mjs <instanceName>

import { execFileSync } from "node:child_process";

const name = process.argv[2];
if (!name) process.exit(0); // misconfigured → surface it

try {
	const out = execFileSync("agentmux", ["inspect", name, "--json"], { encoding: "utf-8" });
	const status = JSON.parse(out)?.status;
	process.exit(status === "busy" ? 1 : 0);
} catch {
	process.exit(0); // agentmux missing / instance gone / parse error → wake and let the agent decide
}
