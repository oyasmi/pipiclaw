/**
 * The `purpose=verify` verdict rule, shared by the internal verifier path (`tool.ts`) and the
 * external one (`external/settlement.ts`).
 *
 * Spec 052, D6: a verifier's verdict is information for the leader, not a gate the runtime
 * enforces. The runtime no longer snapshots the workspace or writes attestations; it reads the
 * checker's declared `VERDICT:` line, records it on the run and on the task's board, and the
 * leader decides whether to trust it. The only thing the runtime still refuses to believe is a
 * run that did not finish cleanly or did not say anything verdict-shaped.
 */
export type VerificationVerdict = "pass" | "fail";

/** The final `VERDICT: PASS|FAIL` line of a checker's output, if there is one. */
export function parseVerificationVerdict(output: string): VerificationVerdict | undefined {
	const value = /(?:^|\n)VERDICT:\s*(PASS|FAIL)\s*$/i.exec(output.trim())?.[1]?.toLowerCase();
	return value === "pass" || value === "fail" ? value : undefined;
}

export interface ResolveVerificationVerdictInput {
	finalText: string;
	/** Whether the underlying run itself failed or aborted — a verifier that never finished cleanly
	 *  cannot produce a trustworthy PASS regardless of what it printed. */
	runFailed: boolean;
}

export function resolveVerificationVerdict(input: ResolveVerificationVerdictInput): VerificationVerdict {
	const declared = parseVerificationVerdict(input.finalText);
	return declared === "pass" && !input.runFailed ? "pass" : "fail";
}
