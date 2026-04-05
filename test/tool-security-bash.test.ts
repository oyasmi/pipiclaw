import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/sandbox.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createBashTool } from "../src/tools/bash.js";

class RecordingExecutor implements Executor {
	public readonly calls: Array<{ command: string; options?: ExecOptions }> = [];

	constructor(private readonly result: ExecResult = { code: 0, stdout: "", stderr: "" }) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ command, options });
		return this.result;
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("bash tool security", () => {
	it("blocks dangerous commands before execution", async () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "pipiclaw-bash-security-"));
		tempDirs.push(workspaceDir);
		mkdirSync(workspaceDir, { recursive: true });
		const executor = new RecordingExecutor();
		const tool = createBashTool(executor, {
			securityConfig: DEFAULT_SECURITY_CONFIG,
			securityContext: {
				workspaceDir,
				workspacePath: workspaceDir,
				homeDir: workspaceDir,
				cwd: workspaceDir,
			},
		});

		await expect(tool.execute("call", { label: "danger", command: "rm -rf /" })).rejects.toThrow("Command blocked");
		expect(executor.calls).toEqual([]);
	});
});
