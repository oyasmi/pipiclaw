import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { TestProject } from "vitest/node";

// paths.ts freezes the fallback home before individual fixtures can set their own. Allocate
// once per invocation so workers, concurrent checkouts and later runs cannot inherit old state.
export function createSuiteHome(): string {
	return mkdtempSync(join(tmpdir(), "pipiclaw-vitest-"));
}

export default function setup(project: TestProject): () => void {
	const home = project.config.env.PIPICLAW_HOME;
	if (!home || dirname(home) !== tmpdir() || !basename(home).startsWith("pipiclaw-vitest-")) {
		throw new Error("Use createSuiteHome() for PIPICLAW_HOME in the Vitest config before enabling cleanup.");
	}
	return () => rmSync(home, { recursive: true, force: true });
}
