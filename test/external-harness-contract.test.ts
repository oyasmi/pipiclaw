import { describe, expect, it } from "vitest";
import { claudeCodeHarness } from "../src/subagents/external/claude-code.js";
import { codexCliHarness } from "../src/subagents/external/codex-cli.js";
import { classifyExternalOutcome, type ExternalHarness } from "../src/subagents/external/harness.js";

/**
 * Contract rules every *structured* harness (stream protocol with a terminal event) must honor.
 * `exec` is exempt by design: its stdout text and exit code are the whole protocol, so it can
 * never produce "unparsable" and always reports a protocol status (see exec-harness.test.ts).
 */
const STRUCTURED_HARNESSES: Array<{ harness: ExternalHarness; garbage: string }> = [
	{ harness: claudeCodeHarness, garbage: 'not json\n{"broken"' },
	{ harness: codexCliHarness, garbage: "not json at all\n{{{broken" },
];

describe.each(STRUCTURED_HARNESSES)(
	"$harness.id harness: shared structured-protocol contract",
	({ harness, garbage }) => {
		it("degrades to unparsable instead of throwing on garbage input", () => {
			const outcome = harness.parseOutcome({ eventsText: garbage, exitCode: 1 });
			expect(outcome.protocolStatus).toBe("unparsable");
			expect(outcome.terminalSeen).toBe(false);
		});

		// Exit code alone is not completion evidence for a structured harness: without the protocol's
		// terminal event the run is "absent", and the shared classifier must fail it rather than let
		// a killed-but-exited process count as done.
		it("treats exit 0 without a terminal event as 'absent', which the classifier still fails", () => {
			const outcome = harness.parseOutcome({ eventsText: "", exitCode: 0 });
			expect(outcome.protocolStatus).toBe("absent");
			expect(outcome.terminalSeen).toBe(false);
			expect(classifyExternalOutcome(harness.id, outcome).status).toBe("failed");
		});
	},
);
