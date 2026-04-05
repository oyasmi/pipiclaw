import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/sandbox.js";
import { createWriteTool } from "../src/tools/write.js";
import { writeContent } from "../src/tools/write-content.js";

class ScriptedExecutor implements Executor {
	public readonly calls: Array<{ command: string; options?: ExecOptions }> = [];

	constructor(private readonly results: Array<ExecResult>) {}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		this.calls.push({ command, options });
		const result = this.results.shift();
		if (!result) {
			throw new Error(`Unexpected command: ${command}`);
		}
		return result;
	}

	getWorkspacePath(hostPath: string): string {
		return hostPath;
	}
}

describe("write-content", () => {
	it("streams content over stdin and can create parent directories", async () => {
		const executor = new ScriptedExecutor([{ code: 0, stdout: "", stderr: "" }]);

		await writeContent(executor, "nested/file.txt", "hello", undefined, { createParentDir: true });

		expect(executor.calls).toEqual([
			{
				command: "mkdir -p 'nested' && cat > 'nested/file.txt'",
				options: { signal: undefined, stdin: "hello" },
			},
		]);
	});

	it("streams large content over stdin", async () => {
		const largeContent = "x".repeat(64 * 1024 + 1);
		const executor = new ScriptedExecutor([{ code: 0, stdout: "", stderr: "" }]);

		await writeContent(executor, "large.txt", largeContent, undefined);

		expect(executor.calls).toEqual([
			{
				command: "cat > 'large.txt'",
				options: { signal: undefined, stdin: largeContent },
			},
		]);
	});

	it("preserves special characters by sending content through stdin instead of the shell", async () => {
		const content = "line 1\nit's `dangerous` $(rm -rf /)\nbackslash\\\\done";
		const executor = new ScriptedExecutor([{ code: 0, stdout: "", stderr: "" }]);

		await writeContent(executor, "special.txt", content, undefined);

		expect(executor.calls).toEqual([
			{
				command: "cat > 'special.txt'",
				options: { signal: undefined, stdin: content },
			},
		]);
		expect(executor.calls[0]?.command).not.toContain("dangerous");
	});

	it("throws when writes fail and write tool wraps successful writes", async () => {
		const failingExecutor = new ScriptedExecutor([{ code: 1, stdout: "", stderr: "disk full" }]);
		await expect(writeContent(failingExecutor, "broken.txt", "hello", undefined)).rejects.toThrow("disk full");

		const toolExecutor = new ScriptedExecutor([{ code: 0, stdout: "", stderr: "" }]);
		const tool = createWriteTool(toolExecutor);
		const result = await tool.execute("call", { label: "write", path: "dir/out.txt", content: "hello界" });

		expect(toolExecutor.calls[0].command).toContain("mkdir -p 'dir'");
		expect(result).toEqual({
			content: [{ type: "text", text: "Successfully wrote 8 bytes to dir/out.txt" }],
			details: undefined,
		});
	});
});
