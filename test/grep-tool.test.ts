import { describe, expect, it } from "vitest";
import type { Executor } from "../src/executor.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createGrepTool } from "../src/tools/grep.js";

function fakeExecutor(stdout: string, code = 0, stderr = ""): { executor: Executor; commands: string[] } {
	const commands: string[] = [];
	const executor: Executor = {
		exec: async (command: string) => {
			commands.push(command);
			return { stdout, stderr, code };
		},
	};
	return { executor, commands };
}

// Security is exercised elsewhere; disable it here so the tests focus on parsing/shaping.
const securityConfig = { ...DEFAULT_SECURITY_CONFIG, enabled: false };

function makeTool(stdout: string, code = 0, stderr = "") {
	const { executor, commands } = fakeExecutor(stdout, code, stderr);
	return { tool: createGrepTool(executor, { securityConfig }), commands };
}

async function run(tool: ReturnType<typeof createGrepTool>, args: Record<string, unknown>): Promise<string> {
	const result = await tool.execute("call", { label: "search", pattern: "x", ...args } as never);
	return result.content[0].type === "text" ? result.content[0].text : "";
}

describe("grep tool", () => {
	it("groups matches by file and marks match vs context lines", async () => {
		const stdout = ["a.txt-1-alpha", "a.txt:2:beta match", "a.txt-3-gamma", "sub/b.txt:5:yes match"].join("\n");
		const { tool } = makeTool(stdout);
		const text = await run(tool, { pattern: "match" });

		expect(text).toContain("== a.txt ==");
		expect(text).toContain(" 1:alpha");
		expect(text).toContain("*2:beta match");
		expect(text).toContain(" 3:gamma");
		expect(text).toContain("== sub/b.txt ==");
		expect(text).toContain("*5:yes match");
	});

	it("attributes context unambiguously even for hyphenated numeric filenames", async () => {
		// `a-1-x.txt` before-context precedes its first match; naive parsing would misread the line
		// number out of the filename. Anchoring on the match path keeps it correct.
		const stdout = ["a-1-x.txt-9-before", "a-1-x.txt:10:the match"].join("\n");
		const { tool } = makeTool(stdout);
		const text = await run(tool, { pattern: "match" });

		expect(text).toContain("== a-1-x.txt ==");
		expect(text).toContain(" 9:before");
		expect(text).toContain("*10:the match");
	});

	it("caps matches per file in multi-file scopes", async () => {
		const fileA = Array.from({ length: 25 }, (_, i) => `a.txt:${i + 1}:hit`).join("\n");
		const stdout = `${fileA}\nb.txt:1:hit`;
		const { tool } = makeTool(stdout);
		const text = await run(tool, { pattern: "hit" });

		expect(text).toContain("*20:hit");
		expect(text).not.toContain("*21:hit");
		expect(text).toContain("capped at 20 matches");
	});

	it("paginates files and reports the next skip offset", async () => {
		const lines: string[] = [];
		for (let f = 0; f < 25; f++) {
			lines.push(`f${String(f).padStart(2, "0")}.txt:1:hit`);
		}
		const { tool } = makeTool(lines.join("\n"));
		const text = await run(tool, { pattern: "hit" });

		expect(text).toContain("== f00.txt ==");
		expect(text).toContain("== f19.txt ==");
		expect(text).not.toContain("== f20.txt ==");
		expect(text).toContain("Use skip=20 for the next page");
	});

	it("honors the skip offset", async () => {
		const lines: string[] = [];
		for (let f = 0; f < 25; f++) {
			lines.push(`f${String(f).padStart(2, "0")}.txt:1:hit`);
		}
		const { tool } = makeTool(lines.join("\n"));
		const text = await run(tool, { pattern: "hit", skip: 20 });

		expect(text).toContain("== f20.txt ==");
		expect(text).toContain("== f24.txt ==");
		expect(text).not.toContain("== f19.txt ==");
	});

	it("filters files by glob on the basename", async () => {
		const stdout = ["a.ts:1:hit", "b.js:1:hit", "sub/c.ts:1:hit"].join("\n");
		const { tool } = makeTool(stdout);
		const text = await run(tool, { pattern: "hit", glob: "*.ts" });

		expect(text).toContain("== a.ts ==");
		expect(text).toContain("== sub/c.ts ==");
		expect(text).not.toContain("== b.js ==");
	});

	it("drops matches inside ignored directories", async () => {
		const stdout = ["node_modules/x/index.js:1:hit", "src/real.ts:1:hit"].join("\n");
		const { tool } = makeTool(stdout);
		const text = await run(tool, { pattern: "hit" });

		expect(text).toContain("== src/real.ts ==");
		expect(text).not.toContain("node_modules");
	});

	it("reports no matches with a widening suggestion when grep exits 1", async () => {
		const { tool } = makeTool("", 1);
		const text = await run(tool, { pattern: "hit" });
		expect(text).toContain("No matches found");
		expect(text).toContain("Try a broader pattern");
	});

	it("throws a helpful error when grep fails (exit >= 2)", async () => {
		const { tool } = makeTool("", 2, "grep: invalid option");
		await expect(run(tool, { pattern: "[" })).rejects.toThrow(/grep failed/);
	});

	it("rejects an empty pattern", async () => {
		const { tool } = makeTool("");
		await expect(run(tool, { pattern: "   " })).rejects.toThrow(/must not be empty/);
	});

	it("passes ERE and the pattern safely to grep", async () => {
		const { tool, commands } = makeTool("a.txt:1:hit");
		await run(tool, { pattern: "foo|bar", caseSensitive: false });
		expect(commands[0]).toContain("-E");
		expect(commands[0]).toContain("-i");
		expect(commands[0]).toContain("'foo|bar'");
	});
});
