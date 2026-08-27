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

	it("recognizes model/effort already supplied through flags or Codex config, in any spelling, without duplicating them", () => {
		const flagModel = codexCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["codex", "exec", "-m", "already-set"],
			model: "gpt-5.6-luna",
		});
		expect(flagModel.args.filter((token) => token === "-m")).toHaveLength(1);
		expect(flagModel.args).toContain("already-set");
		expect(flagModel.args).not.toContain("gpt-5.6-luna");

		for (const argv of [
			["codex", "exec", "--config", "model=already-set"],
			["codex", "exec", "--config=model=already-set"],
		]) {
			const configModel = codexCliHarness.buildInvocation({ ...baseInvocation, argv, model: "gpt-5.6-luna" });
			expect(configModel.args).not.toContain("-m");
			expect(configModel.args).not.toContain("gpt-5.6-luna");
		}

		for (const argv of [
			["codex", "exec", "-c", "model_reasoning_effort=low"],
			["codex", "exec", "--config", "model_reasoning_effort=low"],
			["codex", "exec", "--config=model_reasoning_effort=low"],
			["codex", "exec", "-c=model_reasoning_effort=low"],
		]) {
			const effort = codexCliHarness.buildInvocation({ ...baseInvocation, argv, thinkingLevel: "xhigh" });
			expect(effort.args).not.toContain("model_reasoning_effort=xhigh");
			expect(effort.args).not.toContain("model_reasoning_effort=high");
		}
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
});

describe("classifyExternalOutcome (D4 status table)", () => {
	it("requires terminalSeen for structured harnesses, but exec's protocolStatus alone decides", () => {
		expect(
			classifyExternalOutcome("codex-cli", {
				finalText: "x",
				terminalSeen: true,
				protocolStatus: "completed",
				usageKnown: true,
				costKnown: false,
			}).status,
		).toBe("completed");

		for (const [outcome, expected] of [
			[
				{
					finalText: "stdout text",
					terminalSeen: false,
					protocolStatus: "completed",
					usageKnown: false,
					costKnown: false,
				},
				"completed",
			],
			[
				{ finalText: "", terminalSeen: false, protocolStatus: "failed", usageKnown: false, costKnown: false },
				"failed",
			],
		] as const) {
			expect(classifyExternalOutcome("exec", { ...outcome }).status).toBe(expected);
		}
	});
});

describe("codex-cli harness: toProgressLabel (P1a)", () => {
	it("labels a started command_execution item with its first line, clipped to 80 chars", () => {
		const line = JSON.stringify({
			type: "item.started",
			item: { id: "item_2", type: "command_execution", command: "npm run check\nsed -n '1,10p' file.ts" },
		});
		expect(codexCliHarness.toProgressLabel?.(line)).toBe("npm run check");

		const longCommand = `x`.repeat(120);
		const clipped = JSON.stringify({
			type: "item.started",
			item: { id: "item_3", type: "command_execution", command: longCommand },
		});
		expect(codexCliHarness.toProgressLabel?.(clipped)).toBe(longCommand.slice(0, 80));
	});

	it("labels a todo_list update as done/total", () => {
		const line = JSON.stringify({
			type: "item.updated",
			item: {
				id: "item_1",
				type: "todo_list",
				items: [
					{ text: "a", completed: true },
					{ text: "b", completed: true },
					{ text: "c", completed: false },
				],
			},
		});
		expect(codexCliHarness.toProgressLabel?.(line)).toBe("待办 2/3");
	});

	it("returns undefined for agent_message items, garbage, and unrelated event types", () => {
		expect(
			codexCliHarness.toProgressLabel?.(
				JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hi" } }),
			),
		).toBeUndefined();
		expect(codexCliHarness.toProgressLabel?.("not json")).toBeUndefined();
		expect(codexCliHarness.toProgressLabel?.(JSON.stringify({ type: "turn.completed" }))).toBeUndefined();
	});
});
