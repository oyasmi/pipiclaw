import { describe, expect, it } from "vitest";
import { codexCliHarness } from "../src/subagents/external/codex-cli.js";
import { classifyExternalOutcome } from "../src/subagents/external/harness.js";

/** Spec 040, D4: argv assembly and NDJSON parsing for the first structured harness. */

const baseInvocation = {
	argv: ["codex", "exec"],
	artifactDir: "/tmp/artifacts/run-1",
	promptFile: "/tmp/artifacts/run-1/prompt.txt",
	systemPromptFile: "/tmp/artifacts/run-1/system-prompt.txt",
};

describe("codex-cli harness: buildInvocation", () => {
	it("appends --json - and translates thinkingLevel to model_reasoning_effort", () => {
		const result = codexCliHarness.buildInvocation({ ...baseInvocation, thinkingLevel: "high" });
		expect(result.executable).toBe("codex");
		expect(result.args).toEqual(["exec", "-c", "model_reasoning_effort=high", "--json", "-"]);
		expect(result.resumable).toBe(true);
	});

	it("injects -m <model> when the role has a model and the command does not already specify one", () => {
		const result = codexCliHarness.buildInvocation({ ...baseInvocation, model: "gpt-5.6-luna" });
		expect(result.args).toContain("-m");
		expect(result.args).toContain("gpt-5.6-luna");
	});

	it("does not inject -m when the command already specifies -m or --model", () => {
		const result = codexCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["codex", "exec", "-m", "already-set"],
			model: "gpt-5.6-luna",
		});
		expect(result.args.filter((token) => token === "-m")).toHaveLength(1);
		expect(result.args).toContain("already-set");
		expect(result.args).not.toContain("gpt-5.6-luna");
	});

	it("does not inject -c model_reasoning_effort= when the command already specifies it", () => {
		const result = codexCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["codex", "exec", "-c", "model_reasoning_effort=low"],
			thinkingLevel: "xhigh",
		});
		expect(result.args.filter((token) => token === "-c")).toHaveLength(1);
	});

	it("expands $MODEL/$EFFORT/$PROMPT_FILE placeholders in place instead of appending", () => {
		const result = codexCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["codex", "exec", "--model-alias", "$MODEL", "--prompt", "$PROMPT_FILE"],
			model: "gpt-5.6-luna",
			thinkingLevel: "high",
		});
		expect(result.args).toEqual([
			"exec",
			"--model-alias",
			"gpt-5.6-luna",
			"--prompt",
			baseInvocation.promptFile,
			"-c",
			"model_reasoning_effort=high",
			"--json",
			"-",
		]);
	});

	it("builds a resume invocation with father args before 'resume <id>' and --json - last", () => {
		const result = codexCliHarness.buildInvocation({
			...baseInvocation,
			model: "gpt-5.6-luna",
			resumeSessionId: "thread-abc",
		});
		expect(result.args).toEqual(["exec", "-m", "gpt-5.6-luna", "resume", "thread-abc", "--json", "-"]);
	});
});

function ndjson(...records: unknown[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("codex-cli harness: parseOutcome", () => {
	it("extracts the last agent_message and reports completed on turn.completed", () => {
		const outcome = codexCliHarness.parseOutcome({
			eventsText: ndjson(
				{ type: "thread.started", thread_id: "thread-1" },
				{ type: "item.completed", item: { type: "agent_message", text: "partial" } },
				{ type: "item.completed", item: { type: "agent_message", text: "Final answer." } },
				{ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } },
			),
			exitCode: 0,
		});
		expect(outcome.finalText).toBe("Final answer.");
		expect(outcome.terminalSeen).toBe(true);
		expect(outcome.protocolStatus).toBe("completed");
		expect(outcome.sessionId).toBe("thread-1");
		expect(outcome.usageKnown).toBe(true);
		expect(outcome.usage).toMatchObject({ input: 100, output: 20, total: 120 });
		expect(outcome.costKnown).toBe(false); // codex-cli never reports cost (D4).
	});

	it("reports failed with the harness's own error message on turn.failed", () => {
		const outcome = codexCliHarness.parseOutcome({
			eventsText: ndjson({ type: "turn.failed", error: { message: "model overloaded" } }),
			exitCode: 1,
		});
		expect(outcome.terminalSeen).toBe(true);
		expect(outcome.protocolStatus).toBe("failed");
		expect(outcome.errorMessage).toBe("model overloaded");
	});

	it("degrades to unparsable instead of throwing on garbage input", () => {
		const outcome = codexCliHarness.parseOutcome({ eventsText: "not json at all\n{{{broken", exitCode: 1 });
		expect(outcome.protocolStatus).toBe("unparsable");
		expect(outcome.terminalSeen).toBe(false);
	});

	it("exit 0 with no terminal event is 'absent', not silently completed", () => {
		const outcome = codexCliHarness.parseOutcome({
			eventsText: ndjson({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
			exitCode: 0,
		});
		expect(outcome.protocolStatus).toBe("absent");
		expect(outcome.terminalSeen).toBe(false);
		// And the shared classifier must not call this "completed" just because exit code was 0.
		expect(classifyExternalOutcome("codex-cli", outcome).status).toBe("failed");
	});
});

describe("classifyExternalOutcome (D4 status table)", () => {
	it("completed only when terminalSeen and protocolStatus completed", () => {
		expect(
			classifyExternalOutcome("codex-cli", {
				finalText: "x",
				terminalSeen: true,
				protocolStatus: "completed",
				usageKnown: true,
				costKnown: false,
			}).status,
		).toBe("completed");
	});

	it("a signal-killed process with partial events still reports the partial text on failure", () => {
		const result = classifyExternalOutcome("codex-cli", {
			finalText: "partial progress",
			terminalSeen: false,
			protocolStatus: "absent",
			usageKnown: false,
			costKnown: false,
		});
		expect(result.status).toBe("failed");
	});

	it("exec is the explicit exception: protocolStatus alone decides, terminalSeen is not checked", () => {
		expect(
			classifyExternalOutcome("exec", {
				finalText: "stdout text",
				terminalSeen: false,
				protocolStatus: "completed",
				usageKnown: false,
				costKnown: false,
			}).status,
		).toBe("completed");
		expect(
			classifyExternalOutcome("exec", {
				finalText: "",
				terminalSeen: false,
				protocolStatus: "failed",
				usageKnown: false,
				costKnown: false,
			}).status,
		).toBe("failed");
	});
});
