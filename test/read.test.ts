import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/sandbox.js";
import { createReadTool } from "../src/tools/read.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/tools/truncate.js";

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

describe("read tool", () => {
	it("returns image payloads for supported image files", async () => {
		const executor = new ScriptedExecutor([{ code: 0, stdout: "YWJjZA==\n", stderr: "" }]);
		const tool = createReadTool(executor);

		const result = await tool.execute("call", { label: "read image", path: "photo.png" });

		expect(executor.calls).toHaveLength(1);
		expect(executor.calls[0].command).toContain("base64 < 'photo.png'");
		expect(result.details).toBeUndefined();
		expect(result.content).toEqual([
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data: "YWJjZA==", mimeType: "image/png" },
		]);
	});

	it("reads text with offset and limit and reports remaining lines", async () => {
		const executor = new ScriptedExecutor([
			{ code: 0, stdout: "4\n", stderr: "" },
			{ code: 0, stdout: "line2\nline3\nline4\nline5\n", stderr: "" },
		]);
		const tool = createReadTool(executor);

		const result = await tool.execute("call", { label: "read text", path: "notes.txt", offset: 2, limit: 2 });

		expect(executor.calls).toHaveLength(2);
		expect(executor.calls[0].command).toContain("wc -l < 'notes.txt'");
		expect(executor.calls[1].command).toContain("tail -n +2 'notes.txt'");
		expect(result.details).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "text",
				text: "line2\nline3\n\n[2 more lines in file. Use offset=4 to continue]",
			},
		]);
	});

	it("rejects offsets beyond end of file", async () => {
		const executor = new ScriptedExecutor([{ code: 0, stdout: "1\n", stderr: "" }]);
		const tool = createReadTool(executor);

		await expect(tool.execute("call", { label: "read text", path: "notes.txt", offset: 5 })).rejects.toThrow(
			"Offset 5 is beyond end of file (2 lines total)",
		);
	});

	it("reports oversized first lines with a bash hint", async () => {
		const firstLine = "x".repeat(DEFAULT_MAX_BYTES + 256);
		const executor = new ScriptedExecutor([
			{ code: 0, stdout: "0\n", stderr: "" },
			{ code: 0, stdout: `${firstLine}\n`, stderr: "" },
		]);
		const tool = createReadTool(executor);

		const result = await tool.execute("call", { label: "read text", path: "huge.txt" });

		expect(result.details?.truncation?.firstLineExceedsLimit).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Use bash: sed -n '1p' huge.txt | head -c"),
		});
	});

	it("truncates long files and reports the next offset", async () => {
		const longContent = Array.from({ length: DEFAULT_MAX_LINES + 10 }, (_, index) => `line ${index + 1}`).join("\n");
		const executor = new ScriptedExecutor([
			{ code: 0, stdout: `${DEFAULT_MAX_LINES + 9}\n`, stderr: "" },
			{ code: 0, stdout: longContent, stderr: "" },
		]);
		const tool = createReadTool(executor);

		const result = await tool.execute("call", { label: "read text", path: "long.txt" });

		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining(`Use offset=${DEFAULT_MAX_LINES + 1} to continue`),
		});
	});

	it("propagates read failures from the executor", async () => {
		const executor = new ScriptedExecutor([{ code: 1, stdout: "", stderr: "permission denied" }]);
		const tool = createReadTool(executor);

		await expect(tool.execute("call", { label: "read text", path: "secret.txt" })).rejects.toThrow(
			"permission denied",
		);
	});
});
