import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/executor.js";
import { maybeOptimizeCommand } from "../src/tools/command-optimizer.js";
import { RecordingExecutor } from "./helpers/recording-executor.js";

const OK = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });

/**
 * A successful `rtk rewrite` in rtk 0.43.0 prints the rewrite AND exits 3 (not 0). We key
 * off stdout, not the exit code, so tests use the real exit codes to lock that contract in.
 */
const REWRITE_OK = (stdout: string): ExecResult => ({ code: 3, stdout, stderr: "" });
const REWRITE_NONE: ExecResult = { code: 1, stdout: "", stderr: "" };

/** Route probe (`command -v rtk`) and rewrite (`rtk rewrite …`) through one handler. */
function executor(opts: { available: boolean; rewrite: (command: string) => ExecResult }): RecordingExecutor {
	return new RecordingExecutor((command) => {
		if (command === "command -v rtk") {
			return opts.available ? OK("/usr/bin/rtk") : { code: 1, stdout: "", stderr: "" };
		}
		return opts.rewrite(command);
	});
}

describe("maybeOptimizeCommand", () => {
	it("returns the rewritten command when rtk optimizes it (exits 3, not 0)", async () => {
		const exec = executor({ available: true, rewrite: () => REWRITE_OK("rtk git status\n") });

		const result = await maybeOptimizeCommand("git status", exec);

		expect(result).toBe("rtk git status");
		expect(exec.calls.map((c) => c.command)).toEqual(["command -v rtk", "rtk rewrite 'git status'"]);
	});

	it("falls back to the original command when rtk is not installed", async () => {
		const exec = executor({ available: false, rewrite: () => OK("should-not-run") });

		const result = await maybeOptimizeCommand("git status", exec);

		expect(result).toBe("git status");
		// Only the probe runs; no rewrite is attempted.
		expect(exec.calls.map((c) => c.command)).toEqual(["command -v rtk"]);
	});

	it("falls back when rtk has no equivalent (empty output, exit 1)", async () => {
		const exec = executor({ available: true, rewrite: () => REWRITE_NONE });

		expect(await maybeOptimizeCommand("echo hello", exec)).toBe("echo hello");
	});

	it("falls back when rtk prints only whitespace", async () => {
		const exec = executor({ available: true, rewrite: () => REWRITE_OK("   \n") });

		expect(await maybeOptimizeCommand("cat foo.txt", exec)).toBe("cat foo.txt");
	});

	it("falls back when the rewrite invocation throws", async () => {
		const exec = new RecordingExecutor((command) => {
			if (command === "command -v rtk") return OK("/usr/bin/rtk");
			throw new Error("boom");
		});

		expect(await maybeOptimizeCommand("git status", exec)).toBe("git status");
	});

	it("memoizes the availability probe across calls on the same executor", async () => {
		const exec = executor({ available: true, rewrite: () => REWRITE_OK("rtk git status") });

		await maybeOptimizeCommand("git status", exec);
		await maybeOptimizeCommand("git status", exec);

		const probes = exec.calls.filter((c) => c.command === "command -v rtk");
		expect(probes).toHaveLength(1);
	});

	it("returns the original command without probing when the signal is already aborted", async () => {
		const exec = executor({ available: true, rewrite: () => REWRITE_OK("rtk git status") });

		const result = await maybeOptimizeCommand("git status", exec, AbortSignal.abort());

		expect(result).toBe("git status");
		expect(exec.calls).toHaveLength(0);
	});
});
