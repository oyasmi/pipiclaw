import { isAbsolute, relative, resolve, sep } from "node:path";
import type { GradeResult, Severity, TraceEvent, TrialContext } from "./schema.js";

/** Facts introduced by spec 071. Absent on older archives, which stay inconclusive instead of flipping. */
export const EVIDENCE_EPOCH = "071";

export type EvidenceVerdict = boolean | "missing";

export function evidenceReady(ctx: TrialContext): boolean {
	return ctx.trace.some((event) => event.fields?.evidenceEpoch === EVIDENCE_EPOCH);
}

export function evidenceGrade(
	ctx: TrialContext,
	graderId: string,
	graderVersion: string,
	verdict: EvidenceVerdict,
	rationale: string,
	severity: Severity = "quality",
): GradeResult {
	const missing = verdict === "missing";
	const status = missing ? (evidenceReady(ctx) ? "fail" : "error") : verdict ? "pass" : "fail";
	return {
		schemaVersion: 1,
		graderId,
		graderVersion,
		graderKind: "code",
		status,
		severity,
		evidence: [{ kind: "trace", ref: "trace.jsonl" }],
		rationale: status === "error" ? `evidence unavailable: ${rationale}` : rationale,
	};
}

export function locateWithinRoots(
	path: string,
	roots: Array<{ name: string; dir: string }>,
): { root: string; rel: string } | undefined {
	const resolved = resolve(path);
	const ordered = [...roots].sort((left, right) => right.dir.length - left.dir.length);
	for (const root of ordered) {
		const rel = relative(resolve(root.dir), resolved);
		if (rel === "") return { root: root.name, rel: "" };
		if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
		return { root: root.name, rel: rel.split(sep).join("/") };
	}
	return undefined;
}

export function commandObservations(ctx: TrialContext): TraceEvent[] {
	return ctx.trace.filter((event) => event.fields?.observation === "command");
}

export function compactionObservations(ctx: TrialContext): TraceEvent[] {
	return ctx.trace.filter((event) => event.fields?.observation === "compaction");
}

export function maintenanceDayKey(ctx: TrialContext): string | undefined {
	return ctx.trace.find((event) => event.fields?.observation === "maintenance-day")?.fields?.dayKey;
}

/** A shell redirect, not an arrow function or comparison. */
export const SHELL_REDIRECT = /(?:^|[\s;|&`(])\d?>>?/;

export function isGuardRefusal(detail: string): boolean {
	return /command guard|path guard|blocked by|denied|not permitted|security refusal|守卫|拒绝执行/i.test(detail);
}

/** Real test failure from exit status or an assertion signal. A guard refusal is not one. */
export function isTestFailureSignal(detail: string): boolean {
	if (isGuardRefusal(detail)) return false;
	return /ERR_(?:ASSERTION|TEST_FAILURE)|\bexitCode:\s*[1-9]\d*\b|\bnot ok\s+\d+|# fail\s+[1-9]\d*/i.test(detail);
}
