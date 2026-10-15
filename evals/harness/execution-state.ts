import { join } from "node:path";
import { hash, hashFile, tree } from "./util.js";

/** Hash executable inputs, not timestamps or TypeScript's incremental bookkeeping. */
export function executionFingerprint(root = process.cwd()): string {
	const files = tree(join(root, "dist-evals")).filter((entry) => /\.(?:js|md|json)$/.test(entry.path));
	if (!files.length)
		throw new Error("Compiled evaluator is missing; run npm run eval:build before executing a trial.");
	return hash(
		JSON.stringify({
			files,
			fixtures: tree(join(root, "evals/fixtures")),
			lockfile: hashFile(join(root, "package-lock.json")),
		}),
	);
}

export function assertExecutionUnchanged(expected: string | undefined): void {
	if (expected && executionFingerprint() !== expected)
		throw new Error(
			"Compiled runtime or evaluator changed during this run; use an isolated checkout and start a new cycle. Existing trial evidence is preserved.",
		);
}

export interface ExecutionState {
	schemaVersion: 1;
	expected: string;
	observed?: string;
	status: "running" | "stable" | "changed";
}
