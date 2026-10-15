import type { CodeGrader, TrialContext } from "../harness/schema.js";
import { stepDeliveries } from "./observations.js";

export function verificationVerdict(
	ctx: TrialContext,
	step: number,
): { verified: boolean; evidence: string } | undefined {
	const text = stepDeliveries(ctx, step).at(-1)?.text?.trim();
	if (!text) return;
	try {
		const value = JSON.parse(text.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1")) as {
			verified?: unknown;
			evidence?: unknown;
		} | null;
		if (value && typeof value.verified === "boolean" && typeof value.evidence === "string" && value.evidence.trim())
			return { verified: value.verified, evidence: value.evidence };
	} catch {
		/* Invalid structured evidence is a behavioral result, never a grader crash. */
	}
}

export function verificationField(
	graderId: string,
	step: number,
	predicate: (value: { verified: boolean; evidence: string }) => boolean,
): CodeGrader {
	return {
		graderId,
		graderVersion: "2",
		parameters: { step, predicate: String(predicate) },
		grade: (ctx) => {
			const value = verificationVerdict(ctx, step);
			return {
				schemaVersion: 1,
				graderId,
				graderVersion: "2",
				severity: "quality",
				status: value && predicate(value) ? "pass" : "fail",
				evidence: [{ kind: "delivery", ref: `outcome.json#deliveries[stepIndex=${step}]` }],
				rationale: `The final verification object for user step ${step} must match the actual observation; earlier or later replies cannot substitute.`,
			};
		},
	};
}
