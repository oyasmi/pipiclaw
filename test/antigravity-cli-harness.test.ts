import { describe, expect, it } from "vitest";
import { antigravityCliHarness } from "../src/subagents/external/antigravity-cli.js";
import { classifyExternalOutcome } from "../src/subagents/external/harness.js";
import { resolveVerificationVerdict } from "../src/subagents/verification-outcome.js";

/**
 * Spec 068: argv assembly, stream-json parsing, D5 token accounting, D8 resumed-session verification,
 * and D6 progress labels for `antigravity-cli` (`agy`).
 *
 * Fixture provenance is annotated per test:
 * - [real agy 1.5.9 capture]: sanitized events captured from local `agy 1.5.9` headless runs in P0.5.
 * - [schema/synthetic fault]: constructed against `agy 1.5.9` Go `StreamEvent` / `Result` JSON struct tags
 *   for fault and boundary branches (e.g. `denied_actions`, mid-stream crash, malformed numbers).
 */

const baseInvocation = {
	argv: ["agy", "--dangerously-skip-permissions"],
	artifactDir: "/tmp/artifacts/run-1",
	promptFile: "/tmp/artifacts/run-1/prompt.txt",
	systemPromptFile: "/tmp/artifacts/run-1/system-prompt.txt",
};

function ndjson(events: unknown[]): string {
	return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("antigravity-cli harness: buildInvocation", () => {
	it("appends only --output-format stream-json (never -p/--print/--disable-slash-commands or permission flags), with no presetSessionId", () => {
		const result = antigravityCliHarness.buildInvocation(baseInvocation);
		expect(result.executable).toBe("agy");
		expect(result.resumable).toBe(true);
		expect(result.presetSessionId).toBeUndefined();
		expect(result.args).toEqual(["--dangerously-skip-permissions", "--output-format", "stream-json"]);
		expect(result.args).not.toContain("-p");
		expect(result.args).not.toContain("--print");
		expect(result.args).not.toContain("--prompt");
		expect(result.args).not.toContain("--disable-slash-commands");
		expect(result.args).not.toContain(baseInvocation.promptFile);
		expect(result.warnings).toBeUndefined();

		expect(() => antigravityCliHarness.buildInvocation({ ...baseInvocation, argv: [] })).toThrow(/no argv tokens/);
	});

	it("resumes with --conversation <id> and warns on conflicting output-format, print/interactive, or pinned conversation flags", () => {
		const resumed = antigravityCliHarness.buildInvocation({
			...baseInvocation,
			resumeSessionId: "08d58094-0673-4f63-9173-8483034e3e37",
		});
		expect(resumed.args).toEqual([
			"--dangerously-skip-permissions",
			"--output-format",
			"stream-json",
			"--conversation",
			"08d58094-0673-4f63-9173-8483034e3e37",
		]);
		expect(resumed.presetSessionId).toBeUndefined();

		const conflicted = antigravityCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["agy", "--output-format=json", "-p", "inline", "--continue"],
		});
		expect(conflicted.args).toEqual([
			"--output-format=json",
			"-p",
			"inline",
			"--continue",
			"--output-format",
			"stream-json",
		]);
		const joinedWarnings = conflicted.warnings?.join("\n") ?? "";
		expect(joinedWarnings).toMatch(/stream-json/);
		expect(joinedWarnings).toMatch(/-p\/--print\/--prompt/);
		expect(joinedWarnings).toMatch(/-c\/--continue\/--conversation/);
	});

	it("passes --model and --effort independently, maps off/minimal to low, keeps xhigh/max, and respects $MODEL/$EFFORT placeholders", () => {
		const effortOnly = antigravityCliHarness.buildInvocation({
			...baseInvocation,
			thinkingLevel: "high",
		});
		expect(effortOnly.args).toEqual([
			"--dangerously-skip-permissions",
			"--output-format",
			"stream-json",
			"--effort",
			"high",
		]);

		const offMapped = antigravityCliHarness.buildInvocation({
			...baseInvocation,
			model: "gemini-4-carbon",
			thinkingLevel: "off",
		});
		expect(offMapped.args).toEqual([
			"--dangerously-skip-permissions",
			"--output-format",
			"stream-json",
			"--model",
			"gemini-4-carbon",
			"--effort",
			"low",
		]);

		const minimalAndMax = [
			antigravityCliHarness.buildInvocation({ ...baseInvocation, thinkingLevel: "minimal" }).args,
			antigravityCliHarness.buildInvocation({ ...baseInvocation, thinkingLevel: "xhigh" }).args,
			antigravityCliHarness.buildInvocation({ ...baseInvocation, thinkingLevel: "max" }).args,
		];
		expect(minimalAndMax[0]).toContain("low");
		expect(minimalAndMax[1]).toContain("xhigh");
		expect(minimalAndMax[2]).toContain("max");

		// Wrapper consumes $EFFORT; frontmatter model must still be appended without duplicating --effort.
		const wrapper = antigravityCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["agy-wrapper", "--effort=$EFFORT", "--tag", "$MODEL"],
			model: "gemini-4-carbon",
			thinkingLevel: "medium",
		});
		expect(wrapper.args).toEqual(["--effort=medium", "--tag", "gemini-4-carbon", "--output-format", "stream-json"]);
		expect(wrapper.warnings).toBeUndefined();

		const wrapperOnlyEffort = antigravityCliHarness.buildInvocation({
			...baseInvocation,
			argv: ["agy-wrapper", "--effort", "$EFFORT"],
			model: "gemini-4-carbon",
			thinkingLevel: "medium",
		});
		expect(wrapperOnlyEffort.args).toEqual([
			"--effort",
			"medium",
			"--output-format",
			"stream-json",
			"--model",
			"gemini-4-carbon",
		]);
	});
});

describe("antigravity-cli harness: parseOutcome", () => {
	it("maps real single-turn thinking & cache usage without double-counting thinking_tokens or cache_read_tokens [real agy 1.5.9 capture]", () => {
		// Captured from `agy --output-format stream-json --model gemini-3.8-flash --effort medium`
		// and multi-step cache run on agy 1.5.9: output_tokens (130) already includes thinking_tokens (111),
		// and total_tokens (9634) = input_tokens (9504) + output_tokens (130).
		const outcome = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{
					event: "init",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					init: {
						model: "Gemini 3.8 Flash",
						cwd: "/tmp/agy-probe",
						tools: ["read_file", "write_file", "run_command"],
						permission_mode: "default",
					},
				},
				{
					event: "step_update",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					step_update: {
						conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
						step_index: 2,
						state: "ACTIVE",
						step_type: "agent_response",
						text_delta: "4",
					},
				},
				{
					event: "step_update",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					step_update: {
						conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
						step_index: 2,
						state: "DONE",
						step_type: "agent_response",
						text_delta: "\n",
						usage: {
							input_tokens: 9504,
							output_tokens: 130,
							thinking_tokens: 111,
							cache_read_tokens: 4053,
							total_tokens: 9634,
						},
					},
				},
				{
					event: "result",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					result: {
						conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
						status: "SUCCESS",
						response: "4",
						duration_seconds: 2.38,
						num_turns: 1,
						usage: {
							input_tokens: 9504,
							output_tokens: 130,
							thinking_tokens: 111,
							cache_read_tokens: 4053,
							total_tokens: 9634,
						},
					},
				},
			]),
		});

		expect(outcome.terminalSeen).toBe(true);
		expect(outcome.protocolStatus).toBe("completed");
		expect(outcome.sessionId).toBe("08d58094-0673-4f63-9173-8483034e3e37");
		expect(outcome.finalText).toBe("4");
		expect(outcome.usageKnown).toBe(true);
		expect(outcome.costKnown).toBe(false);
		expect(outcome.usage).toEqual({
			input: 9504,
			output: 130,
			cacheRead: 4053,
			cacheWrite: 0,
			total: 9634,
		});
		expect(classifyExternalOutcome("antigravity-cli", outcome).status).toBe("completed");
	});

	it("repairs missing step boundaries losslessly when concatenated steps match result.response, and preserves non-matching or fallback responses [real agy 1.5.9 delta pattern + synthetic boundary cases]", () => {
		const repaired = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{ event: "init", conversation_id: "conv-verdict", init: { model: "Gemini 4 Carbon" } },
				{
					event: "step_update",
					conversation_id: "conv-verdict",
					step_update: {
						step_index: 2,
						state: "ACTIVE",
						step_type: "agent_response",
						text_delta: "Che",
					},
				},
				{
					event: "step_update",
					conversation_id: "conv-verdict",
					step_update: {
						step_index: 2,
						state: "DONE",
						step_type: "agent_response",
						text_delta: "cking.",
					},
				},
				{
					event: "step_update",
					conversation_id: "conv-verdict",
					step_update: {
						step_index: 4,
						state: "DONE",
						step_type: "agent_response",
						text_delta: "VERDICT: PASS",
					},
				},
				{
					event: "result",
					conversation_id: "conv-verdict",
					result: {
						conversation_id: "conv-verdict",
						status: "SUCCESS",
						response: "Checking.VERDICT: PASS",
						num_turns: 1,
					},
				},
			]),
		});
		expect(repaired.finalText).toBe("Checking.\nVERDICT: PASS");
		expect(resolveVerificationVerdict({ finalText: repaired.finalText, runFailed: false })).toBe("pass");

		// When result.response does NOT equal the exact step concatenation, keep result.response verbatim.
		const unedited = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{
					event: "step_update",
					step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Different step" },
				},
				{
					event: "result",
					conversation_id: "conv-1",
					result: { status: "SUCCESS", response: "Inline VERDICT: PASS without matching step" },
				},
			]),
		});
		expect(unedited.finalText).toBe("Inline VERDICT: PASS without matching step");
		expect(resolveVerificationVerdict({ finalText: unedited.finalText, runFailed: false })).toBe("fail");

		// Empty result.response falls back to step text, then structured_output.
		const structuredFallback = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{
					event: "result",
					conversation_id: "conv-struct",
					result: { status: "SUCCESS", response: "", structured_output: { ok: true } },
				},
			]),
		});
		expect(structuredFallback.finalText).toBe('{"ok":true}');
	});

	it("fails when result has finished_reason: print_timeout even if status is SUCCESS [real agy 1.5.9 print_timeout + changelog 1.1.28]", () => {
		const timedOut = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{ event: "init", conversation_id: "136ba0c6-7eb4-4b23-b122-3e19e2578de7", init: {} },
				{
					event: "result",
					conversation_id: "136ba0c6-7eb4-4b23-b122-3e19e2578de7",
					result: {
						conversation_id: "136ba0c6-7eb4-4b23-b122-3e19e2578de7",
						status: "SUCCESS",
						response: "partial output",
						finished_reason: "print_timeout",
					},
				},
			]),
		});
		expect(timedOut.terminalSeen).toBe(true);
		expect(timedOut.protocolStatus).toBe("failed");
		expect(timedOut.finalText).toBe("partial output");
		expect(timedOut.errorMessage).toContain("print_timeout");
		expect(classifyExternalOutcome("antigravity-cli", timedOut).status).toBe("failed");
	});

	it("preserves init sessionId across empty-id error result and surfaces denied_actions on both failed and completed results [real agy 1.5.9 error capture + schema-backed denied_actions]", () => {
		const failedWithDenied = antigravityCliHarness.parseOutcome({
			exitCode: 1,
			eventsText: ndjson([
				{ event: "init", conversation_id: "conv-keep-me", init: {} },
				{
					event: "result",
					conversation_id: "",
					result: {
						conversation_id: "",
						status: "ERROR",
						response: "",
						error: "permission denied in headless mode",
						denied_actions: ["run_command: rm -rf /tmp/x", "write_file: /etc/hosts"],
						num_turns: 1,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							thinking_tokens: 0,
							cache_read_tokens: 0,
							total_tokens: 0,
						},
					},
				},
			]),
		});
		expect(failedWithDenied.sessionId).toBe("conv-keep-me");
		expect(failedWithDenied.protocolStatus).toBe("failed");
		expect(failedWithDenied.errorMessage).toContain("permission denied in headless mode");
		expect(failedWithDenied.errorMessage).toContain(
			"denied actions: run_command: rm -rf /tmp/x, write_file: /etc/hosts",
		);

		// Completed result with denied_actions keeps completed status, prepends notice before body, and preserves trailing VERDICT.
		const completedWithDenied = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{ event: "init", conversation_id: "conv-ok", init: {} },
				{
					event: "result",
					conversation_id: "conv-ok",
					result: {
						conversation_id: "conv-ok",
						status: "SUCCESS",
						response: "Inspected files via read_file.\nVERDICT: PASS",
						denied_actions: [
							"run_command: git status",
							"run_command: npm test",
							"write_file: a.txt",
							"write_file: b.txt",
							"write_file: c.txt",
							"write_file: d.txt",
						],
					},
				},
			]),
		});
		expect(completedWithDenied.protocolStatus).toBe("completed");
		expect(completedWithDenied.errorMessage).toBeUndefined();
		expect(completedWithDenied.finalText).toMatch(
			/^\[antigravity-cli permission notice\].*\+1 more in events\.jsonl/s,
		);
		expect(completedWithDenied.finalText).toContain("Inspected files via read_file.\nVERDICT: PASS");
		expect(resolveVerificationVerdict({ finalText: completedWithDenied.finalText, runFailed: false })).toBe("pass");
	});

	it("guards against zero-turn error/command usage, invalid token fields, late zero-usage error results, and cumulative resume result.usage [real agy 1.5.9 captures + synthetic fault cases]", () => {
		// 1. Real agy 1.5.9 `/help` command echo: status SUCCESS, num_turns 0, all-zero usage.
		const helpEcho = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{ event: "command_result", command_result: { command: "help", status: "SUCCESS", output: "..." } },
				{
					event: "result",
					conversation_id: "",
					result: {
						conversation_id: "",
						status: "SUCCESS",
						response: "...",
						num_turns: 0,
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							thinking_tokens: 0,
							cache_read_tokens: 0,
							total_tokens: 0,
						},
						command: "help",
					},
				},
			]),
		});
		expect(helpEcho.usageKnown).toBe(false);
		expect(helpEcho.usage).toBeUndefined();

		// 2. Invalid token numbers do not coerce to 0 or pollute the ledger.
		const malformedUsage = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			eventsText: ndjson([
				{
					event: "result",
					conversation_id: "conv-bad-num",
					result: {
						status: "SUCCESS",
						response: "ok",
						num_turns: 1,
						usage: { input_tokens: "100", output_tokens: -5 },
					},
				},
			]),
		});
		expect(malformedUsage.usageKnown).toBe(false);
		expect(malformedUsage.usage).toBeUndefined();

		// 3. Steps already recorded non-zero usage, then a late ERROR result (or print_timeout) arrives with all-zero usage:
		// deduplicated step usage is preserved and zero placeholder updates do not wipe prior non-zero snapshots.
		const fallbackToSteps = antigravityCliHarness.parseOutcome({
			exitCode: 3,
			eventsText: ndjson([
				{ event: "init", conversation_id: "conv-mid", init: {} },
				{
					event: "step_update",
					conversation_id: "conv-mid",
					step_update: {
						step_index: 1,
						state: "DONE",
						step_type: "agent_response",
						text_delta: "Step 1 done.",
						usage: { input_tokens: 5000, output_tokens: 50, cache_read_tokens: 1000, total_tokens: 5050 },
					},
				},
				{
					event: "step_update",
					conversation_id: "conv-mid",
					step_update: {
						step_index: 1,
						state: "DONE",
						step_type: "agent_response",
						usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
					},
				},
				{
					event: "step_update",
					conversation_id: "conv-mid",
					step_update: {
						step_index: 3,
						state: "DONE",
						step_type: "agent_response",
						text_delta: "Step 3 partial.",
						usage: { input_tokens: 6000, output_tokens: 40, cache_read_tokens: 4000, total_tokens: 6040 },
					},
				},
				{
					event: "result",
					conversation_id: "conv-mid",
					result: {
						conversation_id: "conv-mid",
						status: "ERROR",
						response: "",
						error: "print timeout after 50ms",
						finished_reason: "print_timeout",
						usage: {
							input_tokens: 0,
							output_tokens: 0,
							thinking_tokens: 0,
							cache_read_tokens: 0,
							total_tokens: 0,
						},
					},
				},
			]),
		});
		expect(fallbackToSteps.protocolStatus).toBe("failed");
		expect(fallbackToSteps.finalText).toBe("Step 1 done.\nStep 3 partial.");
		expect(fallbackToSteps.usageKnown).toBe(true);
		expect(fallbackToSteps.usage).toEqual({
			input: 11000,
			output: 90,
			cacheRead: 5000,
			cacheWrite: 0,
			total: 11090,
		});

		// 4. Real agy 1.5.9 `--conversation` follow-up capture: `result.usage` is cumulative across Turn 1 + Turn 2
		// (15298 input, 170 output, 15468 total), while `step_update.usage` (step_index 4) is Turn 2 only (5794 input, 40 output, 5834 total).
		const resumedTurn = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			expectedResumeSessionId: "08d58094-0673-4f63-9173-8483034e3e37",
			eventsText: ndjson([
				{ event: "init", conversation_id: "08d58094-0673-4f63-9173-8483034e3e37", init: {} },
				{
					event: "step_update",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					step_update: {
						conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
						step_index: 2,
						state: "DONE",
						step_type: "user_input",
					},
				},
				{
					event: "step_update",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					step_update: {
						conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
						step_index: 4,
						state: "DONE",
						step_type: "agent_response",
						text_delta: "4\n",
						usage: {
							input_tokens: 5794,
							output_tokens: 40,
							thinking_tokens: 36,
							cache_read_tokens: 4053,
							total_tokens: 5834,
						},
					},
				},
				{
					event: "result",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					result: {
						conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
						status: "SUCCESS",
						response: "4",
						num_turns: 2,
						usage: {
							input_tokens: 15298,
							output_tokens: 170,
							thinking_tokens: 147,
							cache_read_tokens: 4053,
							total_tokens: 15468,
						},
					},
				},
			]),
		});
		expect(resumedTurn.protocolStatus).toBe("completed");
		expect(resumedTurn.usageKnown).toBe(true);
		expect(resumedTurn.usage).toEqual({
			input: 5794,
			output: 40,
			cacheRead: 4053,
			cacheWrite: 0,
			total: 5834,
		});

		// When a resumed run has only result.usage (no step usage), do not trust cumulative result.usage.
		const resumedResultOnly = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			expectedResumeSessionId: "08d58094-0673-4f63-9173-8483034e3e37",
			eventsText: ndjson([
				{
					event: "result",
					conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
					result: {
						conversation_id: "08d58094-0673-4f63-9173-8483034e3e37",
						status: "SUCCESS",
						response: "4",
						num_turns: 2,
						usage: { input_tokens: 15298, output_tokens: 170, total_tokens: 15468 },
					},
				},
			]),
		});
		expect(resumedResultOnly.usageKnown).toBe(false);
		expect(resumedResultOnly.usage).toBeUndefined();
	});

	it("enforces D8 resumed-session identity verification (mismatched ID, missing ID, child subagent ID ignored, and matched init + empty error result) [real agy 1.5.9 invalid-conversation capture + synthetic edge cases]", () => {
		// 1. Real agy 1.5.9 behavior when `--conversation 00000000-0000-0000-0000-000000000000` is not found:
		// CLI logs a warning to stderr, silently allocates a new conversation_id, and exits 0 with SUCCESS.
		const mismatched = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			expectedResumeSessionId: "00000000-0000-0000-0000-000000000000",
			stderrTail: 'warning: conversation "00000000-0000-0000-0000-000000000000" not found\n',
			eventsText: ndjson([
				{ event: "init", conversation_id: "be457dbe-9e08-4f66-9a38-7f65bbbe1d32", init: {} },
				{
					event: "step_update",
					conversation_id: "be457dbe-9e08-4f66-9a38-7f65bbbe1d32",
					step_update: {
						step_index: 2,
						state: "DONE",
						step_type: "agent_response",
						text_delta: "FALLBACK_NEW",
						usage: { input_tokens: 9494, output_tokens: 6, total_tokens: 9500 },
					},
				},
				{
					event: "result",
					conversation_id: "be457dbe-9e08-4f66-9a38-7f65bbbe1d32",
					result: {
						conversation_id: "be457dbe-9e08-4f66-9a38-7f65bbbe1d32",
						status: "SUCCESS",
						response: "FALLBACK_NEW",
						usage: { input_tokens: 9494, output_tokens: 6, total_tokens: 9500 },
					},
				},
			]),
		});
		expect(mismatched.protocolStatus).toBe("failed");
		expect(mismatched.sessionId).toBeUndefined();
		expect(mismatched.finalText).toBe("FALLBACK_NEW");
		expect(mismatched.usageKnown).toBe(true);
		expect(mismatched.errorMessage).toContain("00000000-0000-0000-0000-000000000000");
		expect(mismatched.errorMessage).toContain("be457dbe-9e08-4f66-9a38-7f65bbbe1d32");
		expect(classifyExternalOutcome("antigravity-cli", mismatched).status).toBe("failed");

		// 2. Missing conversation_id across the entire stream (even if subagent_info carries a child conversation_id).
		const missingParentId = antigravityCliHarness.parseOutcome({
			exitCode: 0,
			expectedResumeSessionId: "expected-parent-id",
			eventsText: ndjson([
				{
					event: "step_update",
					step_update: {
						step_index: 1,
						state: "ACTIVE",
						subagent_info: { subagents: [{ conversation_id: "expected-parent-id", role: "Helper" }] },
					},
				},
				{
					event: "result",
					result: { status: "SUCCESS", response: "done" },
				},
			]),
		});
		expect(missingParentId.protocolStatus).toBe("failed");
		expect(missingParentId.sessionId).toBeUndefined();
		expect(missingParentId.errorMessage).toContain("expected-parent-id");

		// 3. Matching init followed by an ERROR result with empty conversation_id "" preserves the matched sessionId and original error.
		const matchedInitThenEmptyError = antigravityCliHarness.parseOutcome({
			exitCode: 1,
			expectedResumeSessionId: "conv-valid-1",
			eventsText: ndjson([
				{ event: "init", conversation_id: "conv-valid-1", init: {} },
				{
					event: "result",
					conversation_id: "",
					result: {
						conversation_id: "",
						status: "ERROR",
						response: "",
						error: "transient network error",
					},
				},
			]),
		});
		expect(matchedInitThenEmptyError.protocolStatus).toBe("failed");
		expect(matchedInitThenEmptyError.sessionId).toBe("conv-valid-1");
		expect(matchedInitThenEmptyError.errorMessage).toBe("transient network error");
	});
});

describe("antigravity-cli harness: toProgressLabel", () => {
	it("formats ACTIVE tool and subagent steps, truncates long first-line commands to 80 chars, Never leaks Content/Replacement, and ignores DONE steps", () => {
		const cmdLabel = antigravityCliHarness.toProgressLabel?.(
			JSON.stringify({
				event: "step_update",
				step_update: {
					step_index: 1,
					state: "ACTIVE",
					step_type: "tool",
					tool_name: "run_command",
					tool_info: {
						name: "run_command",
						parameters: {
							CommandLine: `${"npm test -- ".repeat(10)}\nSECRET_SECOND_LINE`,
							output: "SECRET_OUTPUT",
						},
					},
				},
			}),
		);
		expect(cmdLabel).toHaveLength(80);
		expect(cmdLabel?.startsWith("run_command npm test --")).toBe(true);
		expect(cmdLabel).not.toContain("SECRET");

		const writeLabel = antigravityCliHarness.toProgressLabel?.(
			JSON.stringify({
				event: "step_update",
				step_update: {
					step_index: 2,
					state: "ACTIVE",
					step_type: "tool",
					tool_info: {
						name: "write_file",
						parameters: JSON.stringify({
							Path: "/tmp/out.txt",
							Content: "SECRET_FILE_BODY",
							Replacement: "SECRET_REPLACEMENT",
						}),
					},
				},
			}),
		);
		expect(writeLabel).toBe("write_file /tmp/out.txt");
		expect(writeLabel).not.toContain("SECRET");

		const subagentLabel = antigravityCliHarness.toProgressLabel?.(
			JSON.stringify({
				event: "step_update",
				step_update: {
					step_index: 3,
					state: "ACTIVE",
					subagent_info: {
						subagents: [{ type_name: "research", role: "Codebase Researcher", status: "WORKING" }],
					},
				},
			}),
		);
		expect(subagentLabel).toBe("subagent Codebase Researcher");

		const doneStep = antigravityCliHarness.toProgressLabel?.(
			JSON.stringify({
				event: "step_update",
				step_update: {
					step_index: 2,
					state: "DONE",
					step_type: "tool",
					tool_info: { name: "read_file", parameters: { Path: "/tmp/in.txt" } },
				},
			}),
		);
		expect(doneStep).toBeUndefined();
	});
});
