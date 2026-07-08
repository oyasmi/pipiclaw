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
		expect(result.content[0].type).toBe("text");
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Successfully replaced text in notes.txt. Changed 4 characters to 5 characters.");
		// The diff is echoed into the model-visible text so it can confirm the change landed.
		expect(text).toContain("-2 beta");
		expect(text).toContain("+2 delta");
		expect(result.details).toMatchObject({
			diff: expect.stringContaining("-2 beta"),
		});
		expect(result.details).toMatchObject({
			diff: expect.stringContaining("+2 delta"),
		});
	});

	it("replaces every occurrence when replaceAll is set", async () => {
		const executor = new ScriptedExecutor([
			{ code: 0, stdout: "a\nfoo\nfoo\nb\n", stderr: "" },
			{ code: 0, stdout: "", stderr: "" },
		]);
		const tool = createEditTool(executor);

		const result = await tool.execute("call", {
			label: "edit file",
			path: "notes.txt",
			oldText: "foo",
			newText: "bar",
			replaceAll: true,
		});

		expect(executor.calls[1].options?.stdin).toBe("a\nbar\nbar\nb\n");
		expect(result.content[0].type).toBe("text");
		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Replaced 2 occurrences in notes.txt.");
	});

	it("rejects duplicate matches unless replaceAll is set", async () => {
		const tool = createEditTool(new ScriptedExecutor([{ code: 0, stdout: "foo\nfoo\n", stderr: "" }]));
		await expect(
			tool.execute("call", { label: "edit file", path: "notes.txt", oldText: "foo", newText: "bar" }),
		).rejects.toThrow("pass replaceAll: true");
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

	it("escalates a repeated byte-identical no-op to a hard stop, then resets after a real edit", async () => {
		// The read (`cat`) returns the same content on every no-op attempt.
		const reads = Array.from({ length: 4 }, () => ({ code: 0, stdout: "beta\n", stderr: "" }));
		const tool = createEditTool(new ScriptedExecutor(reads));
		const noop = { label: "edit", path: "notes.txt", oldText: "beta", newText: "beta" };

		await expect(tool.execute("c1", noop)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c2", noop)).rejects.toThrow(/No changes made/);
		await expect(tool.execute("c3", noop)).rejects.toThrow(/STOP\./);

		// A successful edit clears the streak so a later same-payload no-op starts soft again.
		const tool2 = new ScriptedExecutor([
			{ code: 0, stdout: "beta\n", stderr: "" }, // no-op #1
			{ code: 0, stdout: "beta\n", stderr: "" }, // no-op #2
			{ code: 0, stdout: "alpha\n", stderr: "" }, // real edit read
			{ code: 0, stdout: "", stderr: "" }, // real edit write
			{ code: 0, stdout: "beta\n", stderr: "" }, // no-op after reset
		]);
		const edit = createEditTool(tool2);
		await expect(edit.execute("c1", noop)).rejects.toThrow(/No changes made/);
		await expect(edit.execute("c2", noop)).rejects.toThrow(/No changes made/);
		await edit.execute("c3", { label: "edit", path: "notes.txt", oldText: "alpha", newText: "omega" });
		// Streak was cleared by the successful edit: this is soft again, not the hard stop.
		await expect(edit.execute("c4", noop)).rejects.toThrow(/No changes made/);
	});
});
