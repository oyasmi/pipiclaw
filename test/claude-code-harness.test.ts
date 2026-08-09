import { describe, expect, it } from "vitest";
import { claudeCodeHarness } from "../src/subagents/external/claude-code.js";
import { classifyExternalOutcome } from "../src/subagents/external/harness.js";

/** Spec 040, D4: argv assembly and stream-json parsing for claude-code. */

const baseInvocation = {
	argv: ["claude"],
	artifactDir: "/tmp/artifacts/run-1",
	promptFile: "/tmp/artifacts/run-1/prompt.txt",
	systemPromptFile: "/tmp/artifacts/run-1/system-prompt.txt",
};

describe("claude-code harness: buildInvocation", () => {
	it("appends -p --output-format stream-json --verbose, a fresh --session-id, and --append-system-prompt-file", () => {
		const result = claudeCodeHarness.buildInvocation(baseInvocation);
		expect(result.executable).toBe("claude");
		expect(result.args).toEqual(
			expect.arrayContaining([
				"-p",
				"--output-format",
				"stream-json",
				"--verbose",
				"--append-system-prompt-file",
				baseInvocation.systemPromptFile,
			]),
		);
		expect(result.args).toContain("--session-id");
		expect(result.presetSessionId).toBeDefined();
		expect(result.args).toContain(result.presetSessionId);
		expect(result.resumable).toBe(true);
	});

	it("uses --resume <session_id> instead of --session-id when resuming, and does not mint a new session id", () => {
		const result = claudeCodeHarness.buildInvocation({ ...baseInvocation, resumeSessionId: "session-abc" });
		expect(result.args).toContain("--resume");
		expect(result.args).toContain("session-abc");
		expect(result.args).not.toContain("--session-id");
		expect(result.presetSessionId).toBeUndefined();
	});

	it("injects --model when the role has one and the command does not already specify it", () => {
		const result = claudeCodeHarness.buildInvocation({ ...baseInvocation, model: "sonnet" });
		expect(result.args).toEqual(expect.arrayContaining(["--model", "sonnet"]));
	});

	it("does not inject --model when the command already specifies -m or --model", () => {
		const result = claudeCodeHarness.buildInvocation({
			...baseInvocation,
			argv: ["claude", "--model", "opus"],
			model: "sonnet",
		});
		expect(result.args.filter((token) => token === "--model")).toHaveLength(1);
		expect(result.args).toContain("opus");
		expect(result.args).not.toContain("sonnet");
	});

	it("does not append --append-system-prompt-file when $SYSTEM_PROMPT_FILE is already used in the command", () => {
		const result = claudeCodeHarness.buildInvocation({
			...baseInvocation,
			argv: ["claude", "--system-prompt-file", "$SYSTEM_PROMPT_FILE"],
		});
		expect(result.args.filter((token) => token === "--append-system-prompt-file")).toHaveLength(0);
		expect(result.args).toContain(baseInvocation.systemPromptFile);
	});
});

function streamJson(...records: unknown[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

describe("claude-code harness: parseOutcome", () => {
	it("extracts the result text, cost, and usage on a successful result event", () => {
		const outcome = claudeCodeHarness.parseOutcome({
			eventsText: streamJson(
				{ type: "system", subtype: "init", session_id: "session-1" },
				{
					type: "result",
					subtype: "success",
					is_error: false,
					result: "Final answer.",
					session_id: "session-1",
					total_cost_usd: 0.042,
					usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
				},
			),
			exitCode: 0,
		});
		expect(outcome.finalText).toBe("Final answer.");
		expect(outcome.terminalSeen).toBe(true);
		expect(outcome.protocolStatus).toBe("completed");
		expect(outcome.sessionId).toBe("session-1");
		expect(outcome.costKnown).toBe(true);
		expect(outcome.usageKnown).toBe(true);
		expect(outcome.usage?.cost?.total).toBeCloseTo(0.042);
	});

	it("reports failed with the harness's own message when is_error is true", () => {
		const outcome = claudeCodeHarness.parseOutcome({
			eventsText: streamJson({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }),
			exitCode: 1,
		});
		expect(outcome.terminalSeen).toBe(true);
		expect(outcome.protocolStatus).toBe("failed");
		expect(outcome.errorMessage).toContain("error_max_turns");
	});

	it("degrades to unparsable instead of throwing on garbage input", () => {
		const outcome = claudeCodeHarness.parseOutcome({ eventsText: "not json\n{broken", exitCode: 1 });
		expect(outcome.protocolStatus).toBe("unparsable");
	});

	it("exit 0 with no result event is 'absent', and the shared classifier still fails it", () => {
		const outcome = claudeCodeHarness.parseOutcome({
			eventsText: streamJson({ type: "system", subtype: "init" }),
			exitCode: 0,
		});
		expect(outcome.protocolStatus).toBe("absent");
		expect(classifyExternalOutcome("claude-code", outcome).status).toBe("failed");
	});
});
