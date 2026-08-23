import { describe, expect, it } from "vitest";
import { resolveVerificationOutcome } from "../src/subagents/verification-outcome.js";

describe("resolveVerificationOutcome (review 2026-08-23 §2.2)", () => {
	it("fails closed when neither a subject hash nor a git-state pair can be compared", () => {
		const outcome = resolveVerificationOutcome({
			finalText: "Checked everything.\nVERDICT: PASS",
			runFailed: false,
		});
		expect(outcome.verdict).toBe("fail");
		expect(outcome.workspaceChanged).toBe(false);
		expect(outcome.evidence).toMatch(/could not determine whether the workspace changed/i);
	});

	it("passes when a comparable subject hash pair shows no change and the verdict is PASS", () => {
		const outcome = resolveVerificationOutcome({
			subjectBefore: "same-hash",
			subjectAfter: "same-hash",
			finalText: "Checked everything.\nVERDICT: PASS",
			runFailed: false,
		});
		expect(outcome.verdict).toBe("pass");
		expect(outcome.workspaceChanged).toBe(false);
	});

	it("fails when the subject hash changed even though the verifier declared PASS", () => {
		const outcome = resolveVerificationOutcome({
			subjectBefore: "before-hash",
			subjectAfter: "after-hash",
			finalText: "Checked everything.\nVERDICT: PASS",
			runFailed: false,
		});
		expect(outcome.verdict).toBe("fail");
		expect(outcome.workspaceChanged).toBe(true);
	});

	it("falls back to a comparable git-state pair when no subject hash is available", () => {
		const outcome = resolveVerificationOutcome({
			gitStateBefore: "clean",
			gitStateAfter: "clean",
			finalText: "Checked everything.\nVERDICT: PASS",
			runFailed: false,
		});
		expect(outcome.verdict).toBe("pass");
		expect(outcome.workspaceChanged).toBe(false);
	});
});
