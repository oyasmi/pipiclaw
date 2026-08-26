import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createBashTool } from "../src/tools/bash.js";
import { createReadTool } from "../src/tools/read.js";
import { writeContent } from "../src/tools/write-content.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { RecordingExecutor } from "./helpers/recording-executor.js";
import { RecordingFileStore } from "./helpers/recording-file-store.js";

// Every tool must apply the security guard *before* touching the executor. These tests assert the
// block happens up front (`executor.calls == []`); guard rule coverage lives in the security/* unit tests.
describe("tool security (guard runs before the executor)", () => {
	const tempDir = useTempDirs("pipiclaw-tool-security-");

	it("bash blocks dangerous commands before execution", async () => {
		const workspaceDir = tempDir();
		const executor = new RecordingExecutor();
		const tool = createBashTool(executor, {
			securityConfig: DEFAULT_SECURITY_CONFIG,
			securityContext: { agentWorkspaceDir: workspaceDir, homeDir: workspaceDir, projectRoot: workspaceDir },
		});

		await expect(tool.execute("call", { command: "rm -rf /" })).rejects.toThrow("Command blocked");
		expect(executor.calls).toEqual([]);
	});

	it("read blocks sensitive paths before invoking the executor", async () => {
		const root = tempDir();
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(join(homeDir, ".ssh"), { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(homeDir, ".ssh", "id_rsa"), "private", "utf-8");

		const executor = new RecordingExecutor();
		const fileStore = new RecordingFileStore();
		const tool = createReadTool(executor, fileStore, {
			securityConfig: DEFAULT_SECURITY_CONFIG,
			securityContext: { agentWorkspaceDir: workspaceDir, homeDir, projectRoot: workspaceDir },
		});

		await expect(tool.execute("call", { path: join(homeDir, ".ssh", "id_rsa") })).rejects.toThrow("Path blocked");
		expect(executor.calls).toEqual([]);
		expect(fileStore.calls).toEqual([]);
	});

	it("write blocks sensitive paths before invoking the executor", async () => {
		const root = tempDir();
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		mkdirSync(join(homeDir, ".ssh"), { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(homeDir, ".ssh", "authorized_keys"), "ssh-rsa AAA", "utf-8");

		const fileStore = new RecordingFileStore();
		await expect(
			writeContent(fileStore, join(homeDir, ".ssh", "authorized_keys"), "changed", undefined, {
				securityConfig: DEFAULT_SECURITY_CONFIG,
				securityContext: { agentWorkspaceDir: workspaceDir, homeDir, projectRoot: workspaceDir },
			}),
		).rejects.toThrow("Path blocked");
		expect(fileStore.calls).toEqual([]);
	});
});
