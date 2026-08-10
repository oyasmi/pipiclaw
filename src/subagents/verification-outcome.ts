import { parseVerificationVerdict } from "../tasks/verification.js";

/**
 * The `purpose=verify` judgment rule, shared by the internal verifier path (`tool.ts`) and the
 * external one (`external/settlement.ts`) — spec 042 D1. Internal and external verify differ in
 * how "did the workspace change" is observed (subject hash vs. a git-status fallback for
 * internal; subject hash only for external, since it has no `Executor` to run `git status`
 * through), which is why both inputs are accepted here rather than picking one. This function
 * does no I/O; writing the attestation itself stays with each caller because `verificationStrength`
 * ("enforced" internal vs. "advisory" external) is a fact only the caller knows.
 */

export interface ResolveVerificationOutcomeInput {
	subjectBefore?: string;
	subjectAfter?: string;
	/** Internal-only fallback, used when a subject hash could not be computed on either side. */
	gitStateBefore?: string;
	gitStateAfter?: string;
	finalText: string;
	/** Whether the underlying run itself failed or aborted — a verifier that never finished cleanly
	 *  cannot produce a trustworthy PASS regardless of what it printed. */
	runFailed: boolean;
}

export interface VerificationOutcome {
	verdict: "pass" | "fail";
	workspaceChanged: boolean;
	evidence: string;
}

export function resolveVerificationOutcome(input: ResolveVerificationOutcomeInput): VerificationOutcome {
	const workspaceChanged =
		input.subjectBefore !== undefined && input.subjectAfter !== undefined
			? input.subjectBefore !== input.subjectAfter
			: input.gitStateBefore !== undefined &&
				input.gitStateAfter !== undefined &&
				input.gitStateBefore !== input.gitStateAfter;
	const declaredVerdict = parseVerificationVerdict(input.finalText);
	const verdict: "pass" | "fail" =
		declaredVerdict === "pass" && !input.runFailed && !workspaceChanged ? "pass" : "fail";
	const evidence = workspaceChanged
		? "Verifier changed tracked workspace files; the attestation is invalid."
		: !declaredVerdict
			? "Verifier did not emit the required final VERDICT marker."
			: input.finalText.trim().slice(0, 8_000);
	return { verdict, workspaceChanged, evidence };
}
