import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceVerdict } from "../harness/evidence.js";
import type { CodeGrader, TrialContext } from "../harness/schema.js";
import { stepDeliveries, toolObservations } from "./observations.js";

export interface StageReport {
	currentTarget: string;
	stages: { A: string; B: string; C: string };
}

export function readStageReport(ctx: TrialContext): StageReport | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(join(ctx.deskDir, "migration-report.json"), "utf8"));
		if (!value || typeof value !== "object") return;
		const record = value as { currentTarget?: unknown; stages?: unknown };
		const stages = record.stages;
		if (!stages || typeof stages !== "object") return;
		const fields = stages as { A?: unknown; B?: unknown; C?: unknown };
		if (
			typeof record.currentTarget !== "string" ||
			![fields.A, fields.B, fields.C].every((item) => typeof item === "string")
		)
			return;
		return {
			currentTarget: record.currentTarget,
			stages: { A: fields.A as string, B: fields.B as string, C: fields.C as string },
		};
	} catch {
		return;
	}
}

/** A stage token must be observed after that stage opened, not merely copied into a note. */
export function stageObservedAfterOpen(ctx: TrialContext, stage: "A" | "B" | "C", token: string): boolean {
	const opened = ctx.trace.find((event) => event.fields?.stageOpened === stage);
	const openSeq = stage === "A" ? 0 : opened?.seq;
	if (openSeq === undefined) return false;
	return toolObservations(ctx).some(
		({ call, result }) =>
			result.ok === true &&
			call.seq > openSeq &&
			(result.fields?.detail ?? "").includes(token) &&
			(call.tool === "read" || call.tool === "bash" || call.tool === "grep"),
	);
}

export function firstRoundSawMissingArtifact(ctx: TrialContext): EvidenceVerdict {
	const checks = toolObservations(ctx).filter(
		({ call }) =>
			call.stepIndex === 0 && /required-artifact\.bin$/.test(call.fields?.path ?? call.fields?.command ?? ""),
	);
	if (!checks.length) return "missing";
	const wroteIt = ctx.trace.some(
		(event) =>
			event.kind === "tool-call" &&
			["write", "edit"].includes(event.tool ?? "") &&
			/required-artifact\.bin$/.test(event.fields?.path ?? "") &&
			(event.stepIndex ?? 0) <= 0,
	);
	if (wroteIt) return false;
	return checks.some(
		({ result }) => result.ok === false || /ENOENT|not found|不存在|缺失/.test(result.fields?.detail ?? ""),
	);
}

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
