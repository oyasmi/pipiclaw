import { describe, expect, it } from "vitest";
import { execHarness } from "../src/subagents/external/exec.js";
import { classifyExternalOutcome } from "../src/subagents/external/harness.js";

/** Spec 040, D4/D9: `exec` is the generic escape hatch — no flags, no protocol terminal, exit
 *  code is the only completion evidence. Explicitly barred from `purpose=verify` (tested at the
 *  tool level, not here). */

describe("exec harness: buildInvocation", () => {
	it("passes the command through unchanged, appending nothing", () => {
		const result = execHarness.buildInvocation({
			argv: ["my-script.sh", "--flag", "value"],
			artifactDir: "/tmp/artifacts/run-1",
			promptFile: "/tmp/artifacts/run-1/prompt.txt",
			systemPromptFile: "/tmp/artifacts/run-1/system-prompt.txt",
		});
		expect(result.executable).toBe("my-script.sh");
		expect(result.args).toEqual(["--flag", "value"]);
		expect(result.resumable).toBe(false);
	});
});

describe("exec harness: parseOutcome", () => {
	it("reports completed on exit 0, with terminalSeen always false", () => {
		const outcome = execHarness.parseOutcome({ eventsText: "plain stdout output\n", exitCode: 0 });
		expect(outcome.finalText).toBe("plain stdout output\n");
		expect(outcome.terminalSeen).toBe(false);
		expect(outcome.protocolStatus).toBe("completed");
		expect(outcome.usageKnown).toBe(false);
		expect(outcome.costKnown).toBe(false);
		expect(classifyExternalOutcome("exec", outcome).status).toBe("completed");
	});

	it("reports failed on a non-zero exit code", () => {
		const outcome = execHarness.parseOutcome({ eventsText: "error output", exitCode: 1 });
		expect(outcome.protocolStatus).toBe("failed");
		expect(classifyExternalOutcome("exec", outcome).status).toBe("failed");
		expect(outcome.errorMessage).toContain("exit");
	});

	it("truncates very long stdout and reports outputTruncated", () => {
		const longText = "x".repeat(20_000);
		const outcome = execHarness.parseOutcome({ eventsText: longText, exitCode: 0 });
		expect(outcome.outputTruncated).toBe(true);
		expect(outcome.finalText.length).toBeLessThan(longText.length);
	});
});
