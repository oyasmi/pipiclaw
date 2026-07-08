import { describe, expect, it } from "vitest";
import { ChannelJobManager } from "../src/agent/job-manager.js";
import type { ExecOptions, ExecResult, Executor } from "../src/sandbox.js";
import { createBashTool, DEFAULT_BASH_TIMEOUT_SECONDS } from "../src/tools/bash.js";
import { DEFAULT_MAX_LINES } from "../src/tools/truncate.js";

class RecordingExecutor implements Executor {
	public readonly calls: Array<{ command: string; options?: ExecOptions }> = [];

	constructor(
		private readonly handler: (command: string, options?: ExecOptions) => Promise<ExecResult> | ExecResult,
	) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ command, options });
		return this.handler(command, options);
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

describe("bash tool", () => {
	it("uses the caller-provided default timeout and returns empty output markers", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const tool = createBashTool(executor, { defaultTimeoutSeconds: 45 });

		const result = await tool.execute("call", { label: "run", command: "true" });

		expect(executor.calls).toEqual([{ command: "true", options: { timeout: 45, signal: undefined } }]);
		expect(result).toEqual({
			content: [{ type: "text", text: "(no output)" }],
			details: undefined,
		});
	});

	it("falls back to the built-in default timeout when none is supplied", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const tool = createBashTool(executor);

		await tool.execute("call", { label: "run", command: "true" });

		expect(executor.calls[0].options?.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
	});

	it("does not consult rtk when the optimizer is disabled (default)", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "ok", stderr: "" }));
		const tool = createBashTool(executor);

		await tool.execute("call", { label: "run", command: "git status" });

		expect(executor.calls.map((c) => c.command)).toEqual(["git status"]);
	});

	it("rejects async execution when no job manager is available", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const tool = createBashTool(executor);

		await expect(tool.execute("call", { label: "long", command: "sleep 100", async: true })).rejects.toThrow(
			/Background execution is not available/,
		);
	});

	it("starts a background job and returns immediately when async with a job manager", async () => {
		const executor = new RecordingExecutor(async (command) => {
			// The launch wrapper backgrounds the command and echoes the nohup PID.
			if (command.includes("nohup")) {
				return { code: 0, stdout: "4242\n", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const jobManager = new ChannelJobManager("dm_1", executor);
		const tool = createBashTool(executor, { jobManager });

		const result = await tool.execute("call", { label: "install deps", command: "npm install", async: true });

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Background job");
		expect(text).toContain("install deps");
		expect(result.details).toMatchObject({ kind: "bash", async: { state: "running" } });
		expect(jobManager.runningCount()).toBe(1);
	});

	it("runs the rtk-rewritten command when the optimizer is enabled", async () => {
		const executor = new RecordingExecutor(async (command) => {
			if (command === "command -v rtk") return { code: 0, stdout: "/usr/bin/rtk", stderr: "" };
			// A real rtk rewrite prints the rewrite but exits 3, not 0.
			if (command === "rtk rewrite 'git status'") return { code: 3, stdout: "rtk git status\n", stderr: "" };
			return { code: 0, stdout: "clean", stderr: "" };
		});
		const tool = createBashTool(executor, { rtkEnabled: true });

		const result = await tool.execute("call", { label: "run", command: "git status" });

		// Probe, rewrite, then execute the rewritten form — not the original.
		expect(executor.calls.map((c) => c.command)).toEqual([
			"command -v rtk",
			"rtk rewrite 'git status'",
			"rtk git status",
		]);
		expect(result.content[0]).toMatchObject({ type: "text", text: "clean" });
	});

	it("runs the original command when rtk is enabled but unavailable", async () => {
		const executor = new RecordingExecutor(async (command) => {
			if (command === "command -v rtk") return { code: 1, stdout: "", stderr: "" };
			return { code: 0, stdout: "clean", stderr: "" };
		});
		const tool = createBashTool(executor, { rtkEnabled: true });

		await tool.execute("call", { label: "run", command: "git status" });

		expect(executor.calls.map((c) => c.command)).toEqual(["command -v rtk", "git status"]);
	});

	it("reports a non-zero exit code as a normal result instead of throwing", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 7, stdout: "partial", stderr: "boom" }));
		const tool = createBashTool(executor);

		const result = await tool.execute("call", { label: "run", command: "false" });

		expect(result.content[0]).toMatchObject({ type: "text", text: "partial\nboom\n\nExit code: 7" });
		expect(result.details).toMatchObject({ exitCode: 7 });
	});

	it("truncates long output and spills the full log through the executor", async () => {
		const output = Array.from(
			{ length: DEFAULT_MAX_LINES + 15 },
			(_, index) => `line ${index + 1} ${"x".repeat(400)}`,
		).join("\n");
		const spilled = new Map<string, string>();
		const executor = new RecordingExecutor(async (command, options) => {
			const spillMatch = command.match(/^cat > '(\/tmp\/pipiclaw-bash-[0-9a-f]+\.log)'$/);
			if (spillMatch) {
				spilled.set(spillMatch[1], options?.stdin ?? "");
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: output, stderr: "" };
		});
		const tool = createBashTool(executor);

		const result = await tool.execute("call", { label: "run", command: "printf ..." });
		const details = result.details as { fullOutputPath?: string; truncation?: { truncated?: boolean } };

		expect(details.truncation?.truncated).toBe(true);
		expect(details.fullOutputPath).toBeTruthy();
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Full output:"),
		});

		if (!details.fullOutputPath) {
			throw new Error("Expected full output path");
		}
		// The spill goes through the executor so the path is reachable inside the sandbox.
		expect(spilled.get(details.fullOutputPath)).toBe(output);
	});

	it("still returns truncated output when the spill write fails", async () => {
		const output = Array.from(
			{ length: DEFAULT_MAX_LINES + 15 },
			(_, index) => `line ${index + 1} ${"x".repeat(400)}`,
		).join("\n");
		const executor = new RecordingExecutor(async (command) => {
			if (command.startsWith("cat > ")) {
				return { code: 1, stdout: "", stderr: "disk full" };
			}
			return { code: 0, stdout: output, stderr: "" };
		});
		const tool = createBashTool(executor);

		const result = await tool.execute("call", { label: "run", command: "printf ..." });
		const details = result.details as { fullOutputPath?: string };

		expect(details.fullOutputPath).toBeUndefined();
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.not.stringContaining("Full output:"),
		});
	});
});
