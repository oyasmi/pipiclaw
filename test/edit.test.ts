import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, Executor } from "../src/sandbox.js";
import { createEditTool } from "../src/tools/edit.js";

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

describe("edit tool", () => {
	it("replaces unique text and returns a diff", async () => {
		const executor = new ScriptedExecutor([
			{ code: 0, stdout: "alpha\nbeta\ngamma\n", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		const tool = createEditTool(executor);

		const result = await tool.execute("call", {
			label: "edit file",
			path: "notes.txt",
			oldText: "beta",
			newText: "delta",
		});

		expect(executor.calls[0].command).toContain("cat 'notes.txt'");
		expect(executor.calls[1].command).toContain("cat > 'notes.txt'");
		expect(executor.calls[1].command).toContain("> 'notes.txt'");
		expect(executor.calls[1].options?.stdin).toBe("alpha\ndelta\ngamma\n");
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Successfully replaced text in notes.txt. Changed 4 characters to 5 characters.",
		});
		expect(result.details).toMatchObject({
			diff: expect.stringContaining("-2 beta"),
		});
		expect(result.details).toMatchObject({
			diff: expect.stringContaining("+2 delta"),
		});
	});

	it("fails when the file cannot be read", async () => {
		const executor = new ScriptedExecutor([{ code: 1, stdout: "", stderr: "missing file" }]);
		const tool = createEditTool(executor);

		await expect(
			tool.execute("call", {
				label: "edit file",
				path: "notes.txt",
				oldText: "beta",
				newText: "delta",
			}),
		).rejects.toThrow("missing file");
	});

	it("fails when the old text does not exist, is duplicated, or makes no change", async () => {
		const toolMissing = createEditTool(new ScriptedExecutor([{ code: 0, stdout: "alpha\nbeta\n", stderr: "" }]));
		await expect(
			toolMissing.execute("call", {
				label: "edit file",
				path: "notes.txt",
				oldText: "omega",
				newText: "delta",
			}),
		).rejects.toThrow("Could not find the exact text");

		const toolDuplicate = createEditTool(new ScriptedExecutor([{ code: 0, stdout: "beta\nbeta\n", stderr: "" }]));
		await expect(
			toolDuplicate.execute("call", {
				label: "edit file",
				path: "notes.txt",
				oldText: "beta",
				newText: "delta",
			}),
		).rejects.toThrow("Found 2 occurrences");

		const toolIdentical = createEditTool(new ScriptedExecutor([{ code: 0, stdout: "beta\n", stderr: "" }]));
		await expect(
			toolIdentical.execute("call", {
				label: "edit file",
				path: "notes.txt",
				oldText: "beta",
				newText: "beta",
			}),
		).rejects.toThrow("No changes made");
	});
});
