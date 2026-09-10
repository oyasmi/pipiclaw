import { describe, expect, it } from "vitest";
import { createExecutor, type ExecOptions, type Executor } from "../src/executor.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createGrepTool } from "../src/tools/grep.js";

function fakeExecutor(
	stdout: string,
	code = 0,
	stderr = "",
	stdoutTruncated = false,
): { executor: Executor; commands: string[] } {
	const commands: string[] = [];
	const executor: Executor = {
		exec: async (command: string) => {
			commands.push(command);
			return { stdout, stderr, code, ...(stdoutTruncated ? { stdoutTruncated: true } : {}) };
		},
	};
	return { executor, commands };
}

// Security is exercised elsewhere; disable it here so the tests focus on parsing/shaping.
const securityConfig = { ...DEFAULT_SECURITY_CONFIG, enabled: false };

function makeTool(stdout: string, code = 0, stderr = "", stdoutTruncated = false) {
	const { executor, commands } = fakeExecutor(stdout, code, stderr, stdoutTruncated);
	return { tool: createGrepTool(executor, { securityConfig }), commands };
}

function makeToolTrackingCalls(stdout: string) {
	const calls: Array<{ command: string; options?: ExecOptions }> = [];
	const commands: string[] = [];
	const executor: Executor = {
		exec: async (command: string, options?: ExecOptions) => {
			calls.push({ command, options });
			commands.push(command);
			return { stdout, stderr: "", code: 0 };
		},
	};
	return { tool: createGrepTool(executor, { securityConfig }), commands, calls };
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

	it("paginates files, reports the next skip offset, and honors it on the next call", async () => {
		const lines: string[] = [];
		for (let f = 0; f < 25; f++) {
			lines.push(`f${String(f).padStart(2, "0")}.txt:1:hit`);
		}
		const { tool } = makeTool(lines.join("\n"));
		const firstPage = await run(tool, { pattern: "hit" });

		expect(firstPage).toContain("== f00.txt ==");
		expect(firstPage).toContain("== f19.txt ==");
		expect(firstPage).not.toContain("== f20.txt ==");
		expect(firstPage).toContain("Use skip=20 for the next page");

		const secondPage = await run(tool, { pattern: "hit", skip: 20 });
		expect(secondPage).toContain("== f20.txt ==");
		expect(secondPage).toContain("== f24.txt ==");
		expect(secondPage).not.toContain("== f19.txt ==");
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

	it("reports no matches with a widening suggestion on exit 1, and throws a helpful error on exit >= 2", async () => {
		const noMatches = makeTool("", 1);
		const text = await run(noMatches.tool, { pattern: "hit" });
		expect(text).toContain("No matches found");
		expect(text).toContain("Try a broader pattern");

		const failed = makeTool("", 2, "grep: invalid option");
		await expect(run(failed.tool, { pattern: "[" })).rejects.toThrow(/grep failed/);
	});

	it("validates the pattern and passes ERE plus the pattern safely to grep", async () => {
		const empty = makeTool("");
		await expect(run(empty.tool, { pattern: "   " })).rejects.toThrow(/must not be empty/);

		const { tool, commands } = makeTool("a.txt:1:hit");
		await run(tool, { pattern: "foo|bar", caseSensitive: false });
		expect(commands[0]).toContain("-E");
		expect(commands[0]).toContain("-i");
		expect(commands[0]).toContain("'foo|bar'");
	});

	it("pushes ignored-dir and glob filters down into grep itself, and bounds capture by bytes not the executor's default (D5.1/D5.2)", async () => {
		const { tool, commands, calls } = makeToolTrackingCalls("a.ts:1:hit");
		await run(tool, { pattern: "hit", glob: "*.ts" });

		expect(commands[0]).toContain("--exclude-dir=node_modules");
		expect(commands[0]).toContain("--exclude-dir=.git");
		// The glob is model-controlled and the executor runs the command via `sh -c`, so it must be
		// shell-escaped like the pattern and path.
		expect(commands[0]).toContain("--include='*.ts'");
		// Not piped through `head` -- that would mask grep's own exit code behind `head`'s (always 0).
		expect(commands[0]).not.toContain("| head");
		expect(calls[0].options?.maxCaptureBytes).toBeGreaterThan(0);
	});

	it("reports a distinct truncation message instead of 'no matches' when the capture cap was hit before filtering kept anything (D5.3)", async () => {
		// Every line falls inside an ignored directory, so everything is filtered away in JS -- but
		// the executor reports the raw capture was truncated regardless.
		const lines = Array.from({ length: 50 }, (_, i) => `node_modules/x/f${i}.js:1:hit`);
		const { tool } = makeTool(lines.join("\n"), 0, "", true);
		const text = await run(tool, { pattern: "hit" });

		expect(text).toContain("hit the");
		expect(text).toContain("result cap");
		expect(text).not.toContain("Try a broader pattern");
	});
});

// Real-shell regression: the executor runs commands via `sh -c`, and the glob used to reach that
// command unescaped, so a model-controlled glob could append arbitrary shell commands.
describe("grep tool against a real shell (glob injection)", () => {
	function makeRealShellTool(tmpDir: string) {
		return createGrepTool(createExecutor(), {
			securityConfig: { ...DEFAULT_SECURITY_CONFIG, enabled: false },
			securityContext: { agentWorkspaceDir: tmpDir, projectRoot: tmpDir },
		});
	}

	async function runReal(
		tool: ReturnType<typeof createGrepTool>,
		args: Record<string, unknown>,
	): Promise<{ text: string; matchCount: number }> {
		const result = await tool.execute("call", { label: "search", pattern: "hit", ...args } as never);
		return {
			text: result.content[0].type === "text" ? result.content[0].text : "",
			matchCount: (result.details as { matchCount: number }).matchCount,
		};
	}

	it("does not execute shell commands appended to a malicious glob, while a legal glob still filters normally", async () => {
		const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pipiclaw-grep-glob-"));
		try {
			writeFileSync(join(dir, "a.ts"), "hit\n");
			writeFileSync(join(dir, "b.js"), "hit\n");
			// The payload a hostile glob must NOT be able to run.
			const canary = join(dir, "pwned-marker");
			const maliciousGlob = `*.ts; touch ${canary}`;
			const commandInjectionGlob = `*.ts\`touch ${canary}\``;

			const tool = makeRealShellTool(dir);

			// The injected commands may make grep see odd arguments, but they must never run: no
			// marker file may appear. Exit >= 2 (a grep usage error) is fine -- execution of the
			// extra command is what this test forbids.
			const malicious = await runReal(tool, { glob: maliciousGlob });
			const maliciousBacktick = await runReal(tool, { glob: commandInjectionGlob });
			expect(existsSync(canary)).toBe(false);
			expect(malicious.text).not.toContain("== a.ts =="); // nothing legitimate was matched by `*.ts; ...`
			expect(maliciousBacktick.text).not.toContain("== a.ts ==");
			expect(malicious.matchCount).toBe(0);
			expect(maliciousBacktick.matchCount).toBe(0);

			// A legal glob still works end to end through the real shell. The search path is resolved
			// to an absolute one by the path guard, so the group header carries the full path.
			const legal = await runReal(tool, { glob: "*.ts" });
			expect(legal.text).toMatch(/== .*\/a\.ts ==/);
			expect(legal.text).not.toContain("b.js");
			expect(legal.matchCount).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("escapes glob single quotes so a quote-bearing glob cannot break out of its quoting", async () => {
		const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pipiclaw-grep-glob-quote-"));
		try {
			writeFileSync(join(dir, "a.ts"), "hit\n");
			const canary = join(dir, "pwned-marker");
			const tool = makeRealShellTool(dir);

			// A leading `'` closes the quoting shellEscape opens, so an unescaped glob would leave
			// the trailing `; touch ...` outside any quotes and run it. Escaped, the whole glob --
			// quotes included -- stays one literal argument and matches nothing.
			const result = await runReal(tool, { glob: `'*'; touch ${canary}` });
			expect(existsSync(canary)).toBe(false);
			expect(result.matchCount).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// batch 1.4: a recursive grep must not return the contents of a file the read guard would deny.
describe("grep tool read-guard backstop (batch 1.4)", () => {
	it("drops a readDeny'd descendant from a recursive search via the push-down exclude", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pipiclaw-grep-deny-"));
		try {
			mkdirSync(join(dir, "allowed"), { recursive: true });
			mkdirSync(join(dir, "vault"), { recursive: true });
			writeFileSync(join(dir, "allowed", "keep.txt"), "MATCHME in the open\n");
			writeFileSync(join(dir, "vault", "creds.txt"), "MATCHME TOP_SECRET_TOKEN\n");

			const tool = createGrepTool(createExecutor(), {
				securityConfig: {
					...DEFAULT_SECURITY_CONFIG,
					enabled: true,
					pathGuard: { ...DEFAULT_SECURITY_CONFIG.pathGuard, readDeny: [join(dir, "vault")] },
				},
				securityContext: { agentWorkspaceDir: dir, projectRoot: dir },
			});

			const result = await tool.execute("call", { label: "s", pattern: "MATCHME", path: dir } as never);
			const text = result.content[0].type === "text" ? result.content[0].text : "";

			expect(text).toContain("keep.txt");
			expect(text).not.toContain("creds.txt");
			expect(text).not.toContain("TOP_SECRET_TOKEN");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("drops a sensitive-key file the guard denies but the push-down cannot exclude, and reports the exclusion", async () => {
		// `id_rsa` is denied by the sensitive-read rule, not by a `readDeny` prefix, so nothing is
		// pushed into grep's flags — the post-parse `partitionByReadGuard` backstop is what keeps
		// its bytes out of the result. Mutation check: delete the `partitionByReadGuard` call in
		// grep.ts and `id_rsa`'s line appears in `text`.
		const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pipiclaw-grep-deny-key-"));
		try {
			mkdirSync(join(dir, "keys"), { recursive: true });
			writeFileSync(join(dir, "keep.txt"), "MATCHME in the open\n");
			writeFileSync(join(dir, "keys", "id_rsa"), "MATCHME PRIVATE_KEY_BODY\n");

			const tool = createGrepTool(createExecutor(), {
				securityConfig: { ...DEFAULT_SECURITY_CONFIG, enabled: true },
				securityContext: { agentWorkspaceDir: dir, projectRoot: dir },
			});

			const result = await tool.execute("call", { label: "s", pattern: "MATCHME", path: dir } as never);
			const text = result.content[0].type === "text" ? result.content[0].text : "";

			expect(text).toContain("keep.txt");
			expect(text).not.toContain("id_rsa");
			expect(text).not.toContain("PRIVATE_KEY_BODY");
			expect(text).toContain("read policy");
			expect(result.details).toMatchObject({ readDenyExcluded: 1 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("grep tool literal / mode / glob dialect (batch 3.5)", () => {
	it("passes -F for a literal search and -E otherwise", async () => {
		const { tool, commands } = makeToolTrackingCalls("a.ts:1:foo.bar(x)");
		await tool.execute("call", { label: "s", pattern: "foo.bar(", literal: true } as never);
		expect(commands[0]).toContain(" -F ");
		expect(commands[0]).not.toMatch(/\s-E\s/);

		const { tool: t2, commands: c2 } = makeToolTrackingCalls("a.ts:1:hit");
		await t2.execute("call", { label: "s", pattern: "fo+" } as never);
		expect(c2[0]).toContain(" -E ");
	});

	it("mode:files returns only paths and mode:count returns per-file counts", async () => {
		const filesOut = "src/a.ts\nsrc/b.ts\nnode_modules/x/c.ts";
		const { tool } = makeTool(filesOut);
		const files = await tool.execute("call", { label: "s", pattern: "x", mode: "files" } as never);
		const filesText = files.content[0].type === "text" ? files.content[0].text : "";
		expect(filesText).toContain("src/a.ts");
		expect(filesText).toContain("src/b.ts");
		expect(filesText).not.toContain("node_modules"); // ignored dir still filtered
		expect(files.details).toMatchObject({ fileCount: 2, mode: "files" });

		const countOut = "src/a.ts:3\nsrc/b.ts:1\nsrc/c.ts:0";
		const { tool: t2 } = makeTool(countOut);
		const counts = await t2.execute("call", { label: "s", pattern: "x", mode: "count" } as never);
		const countText = counts.content[0].type === "text" ? counts.content[0].text : "";
		expect(countText).toMatch(/3\s+src\/a\.ts/);
		expect(countText).not.toContain("src/c.ts"); // zero-count files dropped
		expect(counts.details).toMatchObject({ matchCount: 4, fileCount: 2 });
	});

	it("the JS glob backstop accepts a brace/class pattern that --include also matches", async () => {
		// `*.{ts,tsx}` used to match nothing in the JS filter -> silent no-results. Now it agrees.
		const out = ["a.ts:1:hit", "b.tsx:1:hit", "c.js:1:hit"].join("\n");
		const { tool } = makeTool(out);
		const text = await run(tool, { glob: "*.{ts,tsx}" });
		expect(text).toContain("a.ts");
		expect(text).toContain("b.tsx");
		expect(text).not.toContain("c.js");
	});
});
