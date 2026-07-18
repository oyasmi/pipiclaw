import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseSummary, GateRule } from "./schema.js";
import { containsCredential, hashFile, parseRatio } from "./util.js";

interface FrozenSummary {
	schemaVersion: 1;
	cases: CaseSummary[];
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function assertPromotableSummary(summary: FrozenSummary, gates: Record<string, GateRule>): void {
	const total = summary.cases.reduce((sum, item) => sum + item.valid + item.invalid, 0);
	const invalid = summary.cases.reduce((sum, item) => sum + item.invalid, 0);
	if (!total || invalid / total > 0.1) {
		throw new Error("Run is inconclusive or empty; only a conclusive full run can become a baseline.");
	}
	for (const [caseId, rule] of Object.entries(gates)) {
		if (rule.gate !== "required") continue;
		const item = summary.cases.find((candidate) => candidate.caseId === caseId);
		if (!item) throw new Error(`Run is not full: required case ${caseId} is missing.`);
		const required = rule.minPass
			? Math.ceil((parseRatio(rule.minPass).passed / parseRatio(rule.minPass).total) * item.valid)
			: item.valid;
		if (!item.valid || item.passed < required) {
			throw new Error(`Run misses required gate ${caseId} (${item.passed}/${item.valid}); do not promote it.`);
		}
	}
}

export function promoteRun(root: string, run: string): string {
	const source = join(root, "evals/results", run);
	if (!existsSync(source)) throw new Error(`Run ${run} not found; run eval first.`);
	for (const required of ["manifest.json", "cases.json", "summary.json", "report.md"]) {
		if (!existsSync(join(source, required))) throw new Error(`Run ${run} is incomplete: ${required} is missing.`);
	}
	if (containsCredential(source))
		throw new Error(`Run ${run} contains credential-like material; redact and rerun before promotion.`);
	const gatesPath = join(root, "evals/gates.json");
	assertPromotableSummary(
		readJson<FrozenSummary>(join(source, "summary.json")),
		readJson<Record<string, GateRule>>(gatesPath),
	);
	const gatesBefore = hashFile(gatesPath);
	const target = join(root, "evals/baselines", run);
	if (existsSync(target)) throw new Error(`Baseline ${run} already exists; baselines are immutable.`);
	mkdirSync(target, { recursive: true });
	for (const file of ["manifest.json", "cases.json", "summary.json", "report.md"]) {
		copyFileSync(join(source, file), join(target, file));
	}
	writeFileSync(
		join(target, "baseline.json"),
		`${JSON.stringify({ schemaVersion: 1, runId: run, promotedAt: new Date().toISOString() }, null, 2)}\n`,
	);
	writeFileSync(
		join(root, "evals/baselines", "latest.json"),
		`${JSON.stringify({ schemaVersion: 1, runId: run }, null, 2)}\n`,
	);
	if (hashFile(gatesPath) !== gatesBefore)
		throw new Error("Baseline promotion changed gates.json; restore it immediately.");
	return target;
}

const invokedAsScript = process.argv[1]?.endsWith("/promote.js") || process.argv[1]?.endsWith("\\promote.js");
if (invokedAsScript) {
	const run = process.env.EVAL_PROMOTE_BASELINE;
	if (!run) throw new Error("Set EVAL_PROMOTE_BASELINE=<runId>.");
	const target = promoteRun(process.cwd(), run);
	process.stdout.write(`Promoted ${run} to ${target}. gates.json was not modified.\n`);
}
