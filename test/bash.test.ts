import { describe, expect, it } from "vitest";
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
