import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { guardPath } from "../src/security/path-guard.js";
import { withSubAgentsDirWriteDeny } from "../src/subagents/discovery.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * Spec 040, D8.1: `workspace/sub-agents/` is denied to the model's own write/edit tools (main
 * agent and sub-agents alike), closing the self-authorization path where the model writes a
 * `runtime: external` role file with an arbitrary `command` and then invokes it.
 */

const makeTempDir = useTempDirs("pipiclaw-subagents-write-deny-");

describe("withSubAgentsDirWriteDeny", () => {
	it("denies writing into workspace/sub-agents/ while leaving the rest of the workspace writable", () => {
		const workspaceDir = makeTempDir();
		mkdirSync(join(workspaceDir, "sub-agents"), { recursive: true });
		const config = withSubAgentsDirWriteDeny(DEFAULT_SECURITY_CONFIG, workspaceDir);
		const ctx = { workspaceDir, cwd: workspaceDir, config: config.pathGuard };

		const denied = guardPath(join(workspaceDir, "sub-agents", "builder.md"), "write", ctx);
		expect(denied.allowed).toBe(false);
		expect(denied.category).toBe("configured-deny");

		// A new file *inside* the denied directory is caught too (prefix match), and it is a read
		// that still succeeds — this only closes the write/edit path (D8.1's stated, accepted gap:
		// it does not close `bash`).
		const deniedNested = guardPath(join(workspaceDir, "sub-agents", "nested", "x.md"), "write", ctx);
		expect(deniedNested.allowed).toBe(false);
		expect(guardPath(join(workspaceDir, "sub-agents", "builder.md"), "read", ctx).allowed).toBe(true);

		// Everything else in the workspace is unaffected.
		expect(guardPath(join(workspaceDir, "MEMORY.md"), "write", ctx).allowed).toBe(true);
	});

	it("does not mutate the input config (returns a new object)", () => {
		const workspaceDir = makeTempDir();
		const before = JSON.stringify(DEFAULT_SECURITY_CONFIG);
		withSubAgentsDirWriteDeny(DEFAULT_SECURITY_CONFIG, workspaceDir);
		expect(JSON.stringify(DEFAULT_SECURITY_CONFIG)).toBe(before);
	});
});
