import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/sandbox.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createReadTool } from "../src/tools/read.js";
import { writeContent } from "../src/tools/write-content.js";

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

describe("read/write tool security", () => {
	it("blocks sensitive reads before invoking the executor", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipiclaw-read-security-"));
		tempDirs.push(root);
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(join(homeDir, ".ssh"), { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(homeDir, ".ssh", "id_rsa"), "private", "utf-8");

		const executor = new RecordingExecutor();
		const tool = createReadTool(executor, {
			securityConfig: DEFAULT_SECURITY_CONFIG,
			securityContext: {
				workspaceDir,
				workspacePath: workspaceDir,
				homeDir,
				cwd: workspaceDir,
			},
		});

		await expect(
			tool.execute("call", { label: "read secret", path: join(homeDir, ".ssh", "id_rsa") }),
		).rejects.toThrow("Path blocked");
		expect(executor.calls).toEqual([]);
	});

	it("blocks sensitive writes before invoking the executor", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipiclaw-write-security-"));
		tempDirs.push(root);
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(join(homeDir, ".ssh"), { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(homeDir, ".ssh", "authorized_keys"), "ssh-rsa AAA", "utf-8");

		const executor = new RecordingExecutor();
		await expect(
			writeContent(executor, join(homeDir, ".ssh", "authorized_keys"), "changed", undefined, {
				securityConfig: DEFAULT_SECURITY_CONFIG,
				securityContext: {
					workspaceDir,
					workspacePath: workspaceDir,
					homeDir,
					cwd: workspaceDir,
				},
			}),
		).rejects.toThrow("Path blocked");
		expect(executor.calls).toEqual([]);
	});
});
