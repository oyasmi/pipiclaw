import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelJobManager } from "../src/agent/job-manager.js";
import { CommandTerminatedError, createExecutor } from "../src/executor.js";
import { createBashTool, DEFAULT_BASH_TIMEOUT_SECONDS } from "../src/tools/bash.js";
import { DEFAULT_MAX_LINES } from "../src/tools/truncate.js";
import { RecordingExecutor } from "./helpers/recording-executor.js";

// The spill file is now written by the executor itself as output streams in (`ExecOptions.spillTo`,
// spec 044 D6.3), and bash.ts deletes it via `unlink` when it turns out not to be needed. The test
// observes the `unlink` call instead of a `cat > file` command or a direct `writeFile`.
const unlinkMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("node:fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs/promises")>()),
	unlink: unlinkMock,
}));

const SPILL_PATH_PATTERN = /^\/tmp\/pipiclaw-bash-[0-9a-f]+\.log$/;

describe("bash tool", () => {
	beforeEach(() => {
		unlinkMock.mockClear();
	});

	it("uses the caller-provided default timeout and returns empty output markers", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const tool = createBashTool(executor, { defaultTimeoutSeconds: 45 });

		const result = await tool.execute("call", { command: "true" });

		expect(executor.calls).toEqual([
			{
				command: "true",
				options: { timeout: 45, signal: undefined, spillTo: expect.stringMatching(SPILL_PATH_PATTERN) },
			},
		]);
		expect(result).toEqual({
			content: [{ type: "text", text: "(no output)" }],
			// A clean run that returned nothing: recorded, but not an effect (see effect-ledger).
			details: { exitCode: 0, producedOutput: false },
		});
		// Output was tiny and never truncated -- the spill file (insurance, not a promised artifact)
		// gets cleaned up rather than left as tmp clutter.
		expect(unlinkMock).toHaveBeenCalledWith(expect.stringMatching(SPILL_PATH_PATTERN));
	});

	it("falls back to the built-in default timeout when none is supplied", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const tool = createBashTool(executor);

		await tool.execute("call", { command: "true" });

		expect(executor.calls[0].options?.timeout).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
	});

	it("does not consult rtk when the optimizer is disabled (default)", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "ok", stderr: "" }));
		const tool = createBashTool(executor);

		await tool.execute("call", { command: "git status" });

		expect(executor.calls.map((c) => c.command)).toEqual(["git status"]);
	});

	it("intercepts bare tool-better commands only when the interceptor is enabled", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "ok", stderr: "" }));
		const gated = createBashTool(executor, { interceptorEnabled: true });

		await expect(gated.execute("call", { command: "cat notes.txt" })).rejects.toThrow(/use the read tool/);
		await expect(gated.execute("call", { command: "grep -rn foo ." })).rejects.toThrow(/use the grep tool/);
		await expect(gated.execute("call", { command: "sed -i 's/a/b/' f" })).rejects.toThrow(/use the edit tool/);

		// Compound / piped forms are legitimate and must pass through — including a piped recursive
		// grep, which is a common valid use (`grep -rn foo . | wc -l`) and must not be over-blocked.
		await gated.execute("call", { command: "cat notes.txt | jq ." });
		await gated.execute("call", { command: "grep foo file.txt" });
		await gated.execute("call", { command: "grep -rn foo . | wc -l" });
		// batch 3.5: forms the grep/edit tools cannot express are let through.
		await gated.execute("call", { command: "rg --files -g '*.ts'" });
		await gated.execute("call", { command: "rg -l TODO src" });
		await gated.execute("call", { command: "rg -c TODO src" });
		await gated.execute("call", { command: "sed -i 's/a/b/' f1 f2" });
		await gated.execute("call", { command: "sed -i 's/a/b/' *.txt" });
		expect(executor.calls.map((c) => c.command)).toEqual([
			"cat notes.txt | jq .",
			"grep foo file.txt",
			"grep -rn foo . | wc -l",
			"rg --files -g '*.ts'",
			"rg -l TODO src",
			"rg -c TODO src",
			"sed -i 's/a/b/' f1 f2",
			"sed -i 's/a/b/' *.txt",
		]);
		// A bare content `rg` still gets steered.
		await expect(gated.execute("call", { command: "rg TODO src" })).rejects.toThrow(/use the grep tool/);
	});

	it("does not intercept when the interceptor is disabled (default)", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "ok", stderr: "" }));
		const tool = createBashTool(executor);
		await tool.execute("call", { command: "cat notes.txt" });
		expect(executor.calls.map((c) => c.command)).toEqual(["cat notes.txt"]);
	});

	it("requires a job manager for async runs, and starts a background job when one is available", async () => {
		const plainExecutor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const bare = createBashTool(plainExecutor);

		await expect(bare.execute("call", { command: "sleep 100", async: true })).rejects.toThrow(
			/does not support background execution/,
		);

		const executor = new RecordingExecutor(async (command) => {
			// The launch wrapper backgrounds the command under `setsid` and echoes its PID.
			if (command.includes("setsid")) {
				return { code: 0, stdout: "4242\n", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		});
		const jobManager = new ChannelJobManager("dm_1", executor);
		const tool = createBashTool(executor, { jobManager });

		const result = await tool.execute("call", { command: "npm install", async: true });

		const text = result.content[0].type === "text" ? result.content[0].text : "";
		expect(text).toContain("Background job");
		expect(text).toContain("npm install");
		expect(result.details).toMatchObject({ async: { state: "running" } });
		expect(jobManager.runningCount()).toBe(1);
	});

	it("preserves timeout semantics in async mode and refuses task jobs without a completion wake", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: "", stderr: "" }));
		const manager = new ChannelJobManager("dm_timeout", executor);
		const start = vi.spyOn(manager, "start").mockResolvedValue({
			id: "job_probe",
			label: "check",
			command: "npm test",
			status: "running",
			startedAt: 0,
			durationMs: 0,
		});
		const tool = createBashTool(executor, { jobManager: manager });
		await tool.execute("default", { command: "npm test", async: true });
		expect(start.mock.calls[0]?.[2]).toBe(DEFAULT_BASH_TIMEOUT_SECONDS);
		await tool.execute("long", { command: "npm test", async: true, timeout: 1800, taskId: "T" });
		expect(start.mock.calls[1]?.[2]).toBe(1800);
		expect(start.mock.calls[1]?.[3]).toMatchObject({ taskId: "T", notify: true });
		await expect(
			tool.execute("silent", { command: "npm test", async: true, taskId: "T", notify: false }),
		).rejects.toThrow(/notify=true/);
		expect(start).toHaveBeenCalledTimes(2);
	});

	it("runs the rtk-rewritten command when the optimizer is enabled", async () => {
		const executor = new RecordingExecutor(async (command) => {
			if (command === "command -v rtk") return { code: 0, stdout: "/usr/bin/rtk", stderr: "" };
			// A real rtk rewrite prints the rewrite but exits 3, not 0.
			if (command === "rtk rewrite 'git status'") return { code: 3, stdout: "rtk git status\n", stderr: "" };
			return { code: 0, stdout: "clean", stderr: "" };
		});

		const tool = createBashTool(executor, { rtkEnabled: true });

		const result = await tool.execute("call", { command: "git status" });

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

		await tool.execute("call", { command: "git status" });

		expect(executor.calls.map((c) => c.command)).toEqual(["command -v rtk", "git status"]);
	});

	it("reports a non-zero exit code as a normal result instead of throwing", async () => {
		const executor = new RecordingExecutor(async () => ({ code: 7, stdout: "partial", stderr: "boom" }));
		const tool = createBashTool(executor);

		const result = await tool.execute("call", { command: "false" });

		expect(result.content[0]).toMatchObject({ type: "text", text: "partial\nboom\n\nExit code: 7" });
		expect(result.details).toMatchObject({ exitCode: 7 });
	});

	it("spills long output to a temp file the executor itself streams to, and keeps it when truncated", async () => {
		const output = Array.from(
			{ length: DEFAULT_MAX_LINES + 15 },
			(_, index) => `line ${index + 1} ${"x".repeat(400)}`,
		).join("\n");
		const executor = new RecordingExecutor(async () => ({ code: 0, stdout: output, stderr: "" }));
		const tool = createBashTool(executor);

		const result = await tool.execute("call", { command: "printf ..." });
		const details = result.details as { fullOutputPath?: string; truncation?: { truncated?: boolean } };

		expect(details.truncation?.truncated).toBe(true);
		expect(details.fullOutputPath).toMatch(/^\/tmp\/pipiclaw-bash-[0-9a-f]+\.log$/);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Full output:"),
		});
		// One exec call: the executor streams the spill file itself as output arrives -- no second
		// process and no separate write step for bash.ts to drive.
		expect(executor.calls).toHaveLength(1);
		expect(executor.calls[0].options?.spillTo).toBe(details.fullOutputPath);
		// Truncated: the spill file is the one artifact that actually matters here, so it is kept.
		expect(unlinkMock).not.toHaveBeenCalled();
	});

	// Fix plan §2.2: a timeout/abort must come back as a normal (non-throwing) tool result that
	// goes through the same spill+truncate path as any other output, with an actionable next step
	// -- not a rejection whose message the pi SDK would put verbatim into the model's context.
	it("returns a normal result with the partial output and a retry hint when the command times out", async () => {
		const executor = new RecordingExecutor(async () => {
			throw new CommandTerminatedError("timeout", "partial stdout", "partial stderr", 5);
		});
		const tool = createBashTool(executor);

		const result = await tool.execute("call", { command: "sleep 100" });
		const details = result.details as { timedOut?: boolean; exitCode?: number };

		expect(details.timedOut).toBe(true);
		expect(details.exitCode).toBeUndefined();
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("partial stdout"),
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("timed out after 5 seconds"),
		});
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("async: true"),
		});

		// The same timeout path still spills when the partial output alone exceeds the limits.
		const largeOutput = Array.from(
			{ length: DEFAULT_MAX_LINES + 15 },
			(_, index) => `line ${index + 1} ${"x".repeat(400)}`,
		).join("\n");
		const spillingExecutor = new RecordingExecutor(async () => {
			throw new CommandTerminatedError("timeout", largeOutput, "", 5);
		});
		const spilled = await createBashTool(spillingExecutor).execute("call", { command: "sleep 100" });
		const spilledDetails = spilled.details as { fullOutputPath?: string; timedOut?: boolean };

		expect(spilledDetails.timedOut).toBe(true);
		expect(spilledDetails.fullOutputPath).toMatch(/^\/tmp\/pipiclaw-bash-[0-9a-f]+\.log$/);
	});
});

describe("bash tool spill location and tail (batch 2.2 / 2.3, real executor)", () => {
	it("writes the full-output spill under <channelDir>/logs/ so the model can read it back", async () => {
		// Mutation check: revert getSpillFilePath to always use tmpdir() and fullOutputPath is /tmp/...
		const channelDir = mkdtempSync(join(tmpdir(), "pipiclaw-bash-chan-"));
		const tool = createBashTool(createExecutor(), { channelDir });

		// >50KB across many lines -> tail truncation, but well under the 10MB capture cap.
		const result = await tool.execute("call", {
			command: `for i in $(seq 1 4000); do echo "row $i ${"y".repeat(40)}"; done`,
		});
		const details = result.details as { fullOutputPath?: string };

		expect(details.fullOutputPath).toBeDefined();
		expect(details.fullOutputPath?.startsWith(join(channelDir, "logs") + "/")).toBe(true);
		expect(existsSync(details.fullOutputPath as string)).toBe(true);
		expect(readFileSync(details.fullOutputPath as string, "utf-8")).toContain("row 4000");
	});

	it("shows the true tail of an over-capture command, not its middle", async () => {
		// The executor's in-memory capture stops at 10MB; the naive path would tail *that head* and
		// label it the end. Mutation check: drop the `captureTruncated` branch in buildOutputText
		// and the assertion for "row 900000" fails (you get numbers near the 10MB mark instead).
		const channelDir = mkdtempSync(join(tmpdir(), "pipiclaw-bash-chan-"));
		const tool = createBashTool(createExecutor(), { channelDir });

		const result = await tool.execute("call", {
			// ~13MB, generated fast with awk so the test stays cheap.
			command: `seq 1 300000 | awk '{print "row " $1 " padding-padding-padding-padding-padding-padding"}'`,
		});
		const text = result.content[0].type === "text" ? result.content[0].text : "";

		expect(text).toContain("row 300000"); // the actual last line
		expect(text).toContain("capture was cut off");
		expect(text).not.toMatch(/Showing lines \d+-\d+ of \d+/); // no fabricated total line count
	}, 30000);
});
