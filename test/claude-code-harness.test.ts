import { describe, expect, it } from "vitest";
import { claudeCodeHarness } from "../src/subagents/external/claude-code.js";

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

	it("injects --model and --effort (clamping low-end levels) only when the command lacks them", () => {
		const injected = claudeCodeHarness.buildInvocation({ ...baseInvocation, model: "sonnet" });
		expect(injected.args).toEqual(expect.arrayContaining(["--model", "sonnet"]));

		const effort = claudeCodeHarness.buildInvocation({ ...baseInvocation, thinkingLevel: "high" });
		expect(effort.args).toEqual(expect.arrayContaining(["--effort", "high"]));
		for (const thinkingLevel of ["off", "minimal"] as const) {
			const clamped = claudeCodeHarness.buildInvocation({ ...baseInvocation, thinkingLevel });
			expect(clamped.args).toEqual(expect.arrayContaining(["--effort", "low"]));
		}
	});

	it("does not double any directive the command already carries (--model, --effort, system-prompt)", () => {
		const modelResult = claudeCodeHarness.buildInvocation({
			...baseInvocation,
			argv: ["claude", "--model", "opus"],
			model: "sonnet",
		});
		expect(modelResult.args.filter((token) => token === "--model")).toHaveLength(1);
		expect(modelResult.args).toContain("opus");
		expect(modelResult.args).not.toContain("sonnet");

		for (const argv of [
			["claude", "--effort", "low"],
			["claude", "--effort=low"],
		]) {
			const effortResult = claudeCodeHarness.buildInvocation({ ...baseInvocation, argv, thinkingLevel: "xhigh" });
			expect(effortResult.args.filter((token) => token === "--effort")).toHaveLength(
				argv.includes("--effort") ? 1 : 0,
			);
			expect(effortResult.args).not.toContain("xhigh");
		}

		const systemPromptResult = claudeCodeHarness.buildInvocation({
			...baseInvocation,
			argv: ["claude", "--system-prompt-file", "$SYSTEM_PROMPT_FILE"],
		});
		expect(systemPromptResult.args.filter((token) => token === "--append-system-prompt-file")).toHaveLength(0);
		expect(systemPromptResult.args).toContain(baseInvocation.systemPromptFile);
	});

	// Spec 042, D10: before this fix, an unresolved $MODEL reached argv as the literal string
	// "$MODEL" — a config-only bug that made the CLI misbehave silently rather than fail loudly.
	// The sibling "--model" flag is left orphaned (a separate argv token, untouched by placeholder
	// expansion) — the discovery-time check in discovery.ts is what catches that combination before
	// a role is ever dispatched; `warnings` here is the runtime-visible half of that same fix.
	it("drops an argv token referencing $MODEL when no model is configured, and reports a warning", () => {
		const result = claudeCodeHarness.buildInvocation({
			...baseInvocation,
			argv: ["claude", "--model", "$MODEL"],
			// model intentionally omitted
		});
		expect(result.args).not.toContain("$MODEL");
		expect(result.warnings).toBeDefined();
		expect(result.warnings?.[0]).toContain("$MODEL");
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

	it("falls back to the last streamed assistant text/usage when killed before a result event (§1.2), preferring a real result event when present", () => {
		const outcome = claudeCodeHarness.parseOutcome({
			eventsText: streamJson(
				{ type: "system", subtype: "init", session_id: "session-1" },
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Working on it..." }],
						usage: { input_tokens: 50, output_tokens: 10 },
					},
				},
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Partial progress before the kill." }],
						usage: { input_tokens: 80, output_tokens: 25 },
					},
				},
			),
			exitCode: undefined,
		});
		expect(outcome.finalText).toBe("Partial progress before the kill.");
		expect(outcome.usageKnown).toBe(true);
		expect(outcome.usage?.input).toBe(80);
		expect(outcome.usage?.output).toBe(25);
		// A partial-text fallback is not proof the run finished -- only a real `result` event may say so.
		expect(outcome.terminalSeen).toBe(false);
		expect(outcome.protocolStatus).toBe("absent");

		const withResult = claudeCodeHarness.parseOutcome({
			eventsText: streamJson(
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Draft." }],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				},
				{
					type: "result",
					subtype: "success",
					is_error: false,
					result: "Final answer.",
					usage: { input_tokens: 100, output_tokens: 20 },
				},
			),
			exitCode: 0,
		});
		expect(withResult.finalText).toBe("Final answer.");
		expect(withResult.usage?.input).toBe(100);
	});
});

describe("claude-code harness: toProgressLabel (P1a)", () => {
	it("labels the first tool_use block in a streamed assistant message with its tool name", () => {
		const line = JSON.stringify({
			type: "assistant",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Let me check." },
					{ type: "tool_use", id: "call_1", name: "Bash", input: { command: "npm test" } },
				],
			},
		});
		expect(claudeCodeHarness.toProgressLabel?.(line)).toBe("Bash");
	});

	it("returns undefined for a text-only assistant message, garbage, and non-assistant events", () => {
		const textOnly = JSON.stringify({
			type: "assistant",
			message: { role: "assistant", content: [{ type: "text", text: "Thinking..." }] },
		});
		expect(claudeCodeHarness.toProgressLabel?.(textOnly)).toBeUndefined();
		expect(claudeCodeHarness.toProgressLabel?.("not json")).toBeUndefined();
		expect(claudeCodeHarness.toProgressLabel?.(JSON.stringify({ type: "result" }))).toBeUndefined();
	});
});
