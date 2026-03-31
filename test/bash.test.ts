import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/sandbox.js";
import { createBashTool } from "../src/tools/bash.js";
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

const tempFilesToDelete: string[] = [];

afterEach(() => {
	for (const filePath of tempFilesToDelete.splice(0)) {
		rmSync(filePath, { force: true });
	}
});

describe("bash tool", () => {
	it("uses the default timeout and returns empty output markers", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const tool = createBashTool(executor, { defaultTimeoutSeconds: 45 });

		const result = await tool.execute("call", { label: "run", command: "true" });

		expect(executor.calls).toEqual([{ command: "true", options: { timeout: 45, signal: undefined } }]);
		expect(result).toEqual({
			content: [{ type: "text", text: "(no output)" }],
			details: undefined,
		});
	});

	it("throws when the command exits with a non-zero status", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 7, stdout: "partial", stderr: "boom" }));
		const tool = createBashTool(executor);

		await expect(tool.execute("call", { label: "run", command: "false" })).rejects.toThrow(
			"partial\nboom\n\nCommand exited with code 7",
		);
	});

	it("truncates long output and persists the full log to a temp file", async () => {
		const output = Array.from(
			{ length: DEFAULT_MAX_LINES + 15 },
			(_, index) => `line ${index + 1} ${"x".repeat(400)}`,
		).join("\n");
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: output, stderr: "" }));
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
		tempFilesToDelete.push(details.fullOutputPath);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(existsSync(details.fullOutputPath)).toBe(true);
		expect(readFileSync(details.fullOutputPath, "utf-8")).toBe(output);
	});
});
