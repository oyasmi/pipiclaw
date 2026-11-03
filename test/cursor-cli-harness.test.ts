import { describe, expect, it } from "vitest";
import { cursorCliHarness } from "../src/subagents/external/cursor-cli.js";
import { classifyExternalOutcome } from "../src/subagents/external/harness.js";
import { resolveVerificationVerdict } from "../src/subagents/verification-outcome.js";

/** Spec 066: argv assembly, stream-json parsing, and progress labels for cursor-cli. */

const baseInvocation = {
	argv: ["agent"],
	artifactDir: "/tmp/artifacts/run-1",
	promptFile: "/tmp/artifacts/run-1/prompt.txt",
	systemPromptFile: "/tmp/artifacts/run-1/system-prompt.txt",
};

function ndjson(events: unknown[]): string {
	return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("cursor-cli harness: buildInvocation", () => {
	it("appends the protocol flags and --trust, with no positional prompt and no preset session id", () => {
		const result = cursorCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["agent", "--mode", "ask"],
		});
		expect(result.executable).toBe("agent");
		expect(result.resumable).toBe(true);
		expect(result.presetSessionId).toBeUndefined();
		expect(result.args).toEqual(["--mode", "ask", "-p", "--output-format", "stream-json", "--trust"]);
		expect(result.args).not.toContain(baseInvocation.promptFile);
		expect(result.args).not.toContain("--force");
		expect(result.args).not.toContain("--yolo");
		expect(result.args).not.toContain("-f");
	});

	it("resumes with --resume and the given id, and does not mint a new id", () => {
		const result = cursorCliHarness.buildInvocation({ ...baseInvocation, resumeSessionId: "session-abc" });
		expect(result.args).toEqual(["-p", "--output-format", "stream-json", "--trust", "--resume", "session-abc"]);
		expect(result.presetSessionId).toBeUndefined();
	});

	it("does not append a second --trust when the command already has one", () => {
		for (const argv of [
			["agent", "--trust"],
			["agent", "--trust=workspace"],
		]) {
			const result = cursorCliHarness.buildInvocation({ ...baseInvocation, argv });
			const trustTokens = result.args.filter((token) => token === "--trust" || token.startsWith("--trust="));
			expect(trustTokens).toEqual([argv[1]]);
		}
	});

	it.each([
		{ name: "no brackets", model: "gpt-5", expected: "gpt-5[effort=high]", warning: undefined },
		{
			name: "appends an effort key",
			model: "name[context=1m,fast=false]",
			expected: "name[context=1m,fast=false,effort=high]",
			warning: undefined,
		},
		{
			name: "keeps an existing effort value",
			model: "name[context=1m,effort=low]",
			expected: "name[context=1m,effort=low]",
			warning: /already sets effort=/,
		},
		{
			name: "does not rewrite an illegal bracket",
			model: "name[context=1m]extra",
			expected: "name[context=1m]extra",
			warning: /not a single trailing bracket list/,
		},
	])("$name", ({ model, expected, warning }) => {
		const result = cursorCliHarness.buildInvocation({
			...baseInvocation,
			model,
			thinkingLevel: "high",
		});
		const modelFlag = result.args.indexOf("--model");
		expect(result.args[modelFlag + 1]).toBe(expected);
		if (warning) expect(result.warnings?.join("\n")).toMatch(warning);
		else expect(result.warnings).toBeUndefined();
	});

	it("does not rewrite a model flag the command already carries", () => {
		const result = cursorCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["agent", "--model", "sonnet"],
			model: "gpt-5",
			thinkingLevel: "high",
		});
		expect(result.args).toEqual(["--model", "sonnet", "-p", "--output-format", "stream-json", "--trust"]);
		expect(result.warnings?.join("\n")).toMatch(/already passes --model or -m/);
	});

	it("still appends the frontmatter model when the command consumes $EFFORT and has no model flag", () => {
		const result = cursorCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["cursor-wrapper", "--effort", "$EFFORT"],
			model: "gpt-5",
			thinkingLevel: "high",
		});
		expect(result).toMatchObject({ executable: "cursor-wrapper" });
		expect(result.args).toEqual([
			"--effort",
			"high",
			"-p",
			"--output-format",
			"stream-json",
			"--model",
			"gpt-5",
			"--trust",
		]);
	});

	it("does not add effort= when thinkingLevel is unset", () => {
		const result = cursorCliHarness.buildInvocation({ ...baseInvocation, model: "gpt-5" });
		expect(result.args).toContain("gpt-5");
		expect(result.args.some((token) => token.includes("effort="))).toBe(false);
	});

	it("maps off to low and does not clamp max", () => {
		const off = cursorCliHarness.buildInvocation({ ...baseInvocation, model: "gpt-5", thinkingLevel: "off" });
		expect(off.args).toContain("gpt-5[effort=low]");
		const max = cursorCliHarness.buildInvocation({ ...baseInvocation, model: "gpt-5", thinkingLevel: "max" });
		expect(max.args).toContain("gpt-5[effort=max]");
	});

	it("does not invent a model when thinkingLevel is set and no model is configured", () => {
		const result = cursorCliHarness.buildInvocation({ ...baseInvocation, thinkingLevel: "high" });
		expect(result.args).not.toContain("--model");
		expect(result.warnings?.join("\n")).toMatch(/default model/);
	});

	it("warns when the command requests an output format other than stream-json", () => {
		const result = cursorCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["agent", "--output-format", "text"],
		});
		expect(result.args).toEqual(["--output-format", "text", "-p", "--output-format", "stream-json", "--trust"]);
		expect(result.warnings?.join("\n")).toMatch(/stream-json/);
	});
});

describe("cursor-cli harness: parseOutcome", () => {
	it("prefers the last complete assistant message over the concatenated result text", () => {
		const outcome = cursorCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{ type: "system", subtype: "init", session_id: "sess-1" },
				{ type: "assistant", message: { content: [{ type: "text", text: "Checking." }] } },
				{ type: "assistant", message: { content: [{ type: "text", text: "VERDICT: PASS" }] } },
				{
					type: "assistant",
					timestamp_ms: 3,
					message: { content: [{ type: "text", text: "VERDICT: PASS\nextra" }] },
				},
				{
					type: "result",
					subtype: "success",
					result: "Checking.VERDICT: PASS",
					session_id: "sess-2",
					duration_ms: 10,
					duration_api_ms: 9,
				},
			]),
		});
		expect(outcome.finalText).toBe("VERDICT: PASS");
		expect(outcome.terminalSeen).toBe(true);
		expect(outcome.protocolStatus).toBe("completed");
		expect(outcome.sessionId).toBe("sess-2");
		expect(outcome.usageKnown).toBe(false);
		expect(outcome.costKnown).toBe(false);
		expect(outcome.usage).toBeUndefined();
		expect(resolveVerificationVerdict({ finalText: outcome.finalText, runFailed: false })).toBe("pass");
		expect(classifyExternalOutcome("cursor-cli", outcome).status).toBe("completed");
	});

	it("uses the string result when no complete assistant text was seen", () => {
		const outcome = cursorCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([{ type: "result", subtype: "success", result: "VERDICT: PASS", session_id: "sess-1" }]),
		});
		expect(outcome.finalText).toBe("VERDICT: PASS");
		expect(outcome.protocolStatus).toBe("completed");
		expect(resolveVerificationVerdict({ finalText: outcome.finalText, runFailed: false })).toBe("pass");
	});

	it("keeps a failed result's own message even when assistant text is present", () => {
		const outcome = cursorCliHarness.parseOutcome({
			exitCode: 1,
			eventsText: ndjson([
				{ type: "assistant", message: { content: [{ type: "text", text: "I hit an error" }] } },
				{
					type: "result",
					subtype: "success",
					is_error: true,
					result: "authentication failed",
					session_id: "sess-1",
				},
			]),
		});
		expect(outcome.finalText).toBe("I hit an error");
		expect(outcome.protocolStatus).toBe("failed");
		expect(outcome.errorMessage).toBe("authentication failed");
		expect(outcome.usageKnown).toBe(false);
		expect(outcome.costKnown).toBe(false);
		expect(classifyExternalOutcome("cursor-cli", outcome).status).toBe("failed");
	});

	it("reports the failure subtype when the result text is empty", () => {
		const outcome = cursorCliHarness.parseOutcome({
			exitCode: 1,
			eventsText: ndjson([{ type: "result", subtype: "error", is_error: false, result: "  " }]),
		});
		expect(outcome.protocolStatus).toBe("failed");
		expect(outcome.errorMessage).toBe("cursor-cli reported error");
		expect(outcome.finalText).toBe("");
	});

	it("does not treat assistant text as completion when no result event arrived", () => {
		const outcome = cursorCliHarness.parseOutcome({
			exitCode: 0,
			stderrTail: "  Not logged in\n",
			eventsText: ndjson([
				{ type: "system", subtype: "init", session_id: "sess-9" },
				{ type: "assistant", message: { content: [{ type: "text", text: "partial answer" }] } },
			]),
		});
		expect(outcome.terminalSeen).toBe(false);
		expect(outcome.protocolStatus).toBe("absent");
		expect(outcome.finalText).toBe("partial answer");
		expect(outcome.sessionId).toBe("sess-9");
		expect(outcome.errorMessage).toBe("Not logged in");
		expect(classifyExternalOutcome("cursor-cli", outcome).status).toBe("failed");
	});

	it("ignores incremental assistant lines when choosing the final text", () => {
		const outcome = cursorCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{ type: "assistant", timestamp_ms: 1, message: { content: [{ type: "text", text: "Che" }] } },
				{ type: "assistant", model_call_id: "call-1", message: { content: [{ type: "text", text: "Checking." }] } },
				{ type: "result", subtype: "success", result: "" },
			]),
		});
		expect(outcome.finalText).toBe("");
		expect(outcome.protocolStatus).toBe("completed");
	});
});

describe("cursor-cli harness: toProgressLabel", () => {
	it("labels a readToolCall with its path", () => {
		const label = cursorCliHarness.toProgressLabel?.(
			JSON.stringify({
				type: "tool_call",
				subtype: "started",
				tool_call: { readToolCall: { args: { path: "src/a.ts" } } },
			}),
		);
		expect(label).toBe("read src/a.ts");
	});

	it("does not include file text from a writeToolCall", () => {
		const label = cursorCliHarness.toProgressLabel?.(
			JSON.stringify({
				type: "tool_call",
				subtype: "started",
				tool_call: {
					writeToolCall: {
						args: {
							path: "src/a.ts",
							fileText: "SECRET_FILE",
							content: "SECRET_CONTENT",
							result: "SECRET_RESULT",
						},
					},
				},
			}),
		);
		expect(label).toBe("write src/a.ts");
		expect(label).not.toContain("SECRET");
	});

	it("returns undefined for a completed tool call and for garbage", () => {
		const completed = cursorCliHarness.toProgressLabel?.(
			JSON.stringify({
				type: "tool_call",
				subtype: "completed",
				tool_call: { readToolCall: { args: { path: "src/a.ts" } } },
			}),
		);
		expect(completed).toBeUndefined();
		expect(cursorCliHarness.toProgressLabel?.("not json")).toBeUndefined();
	});

	it("keeps only the first line of a long command and truncates the label to 80 characters", () => {
		const label = cursorCliHarness.toProgressLabel?.(
			JSON.stringify({
				type: "tool_call",
				subtype: "started",
				tool_call: { shellToolCall: { args: { command: `${"a".repeat(120)}\nSECRET_SECOND` } } },
			}),
		);
		expect(label).toHaveLength(80);
		expect(label?.startsWith("shell a")).toBe(true);
		expect(label).not.toContain("SECRET_SECOND");

		const collapsed = cursorCliHarness.toProgressLabel?.(
			JSON.stringify({
				type: "tool_call",
				subtype: "started",
				tool_call: { function: { name: "Shell", arguments: { command: "echo   hi\nsecret" } } },
			}),
		);
		expect(collapsed).toBe("Shell echo hi");
	});

	it("parses function.arguments JSON and ignores a broken arguments string", () => {
		const parsed = cursorCliHarness.toProgressLabel?.(
			JSON.stringify({
				type: "tool_call",
				subtype: "started",
				tool_call: { function: { name: "grep", arguments: JSON.stringify({ pattern: "foo" }) } },
			}),
		);
		expect(parsed).toBe("grep foo");
		const broken = cursorCliHarness.toProgressLabel?.(
			JSON.stringify({
				type: "tool_call",
				subtype: "started",
				tool_call: { function: { name: "grep", arguments: "{" } },
			}),
		);
		expect(broken).toBe("grep");
	});
});
