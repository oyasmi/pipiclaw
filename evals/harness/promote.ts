import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyArtifacts } from "./artifacts.js";
import { canonicalJson } from "./fingerprint.js";
import type { CaseSummary, RunPlan, ScoringPlan, TrialRecord } from "./schema.js";
import { evaluateSummary, summarize } from "./scoring.js";
import { containsCredential, hashFile } from "./util.js";

interface FrozenSummary {
	schemaVersion: 1 | 2;
	cases: CaseSummary[];
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function assertPromotableSummary(summary: FrozenSummary, plan: ScoringPlan): void {
	if (summary.schemaVersion !== 2)
		throw new Error("Legacy scoring cannot establish a baseline; run the current evaluator first.");
	for (const [id, rule] of Object.entries(plan.gates)) {
		if (rule.gate === "required" && !(id in plan.plannedTrials))
			throw new Error(`Run is not full: required case ${id} is missing; run the full suite.`);
	}
	const decision = evaluateSummary(summary.cases, plan);
	if (decision.code !== 0) throw new Error(decision.reason);
}

export function promoteRun(root: string, run: string): string {
	if (!/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error("Invalid run id; use the id printed by eval.");
	const source = join(root, "evals/results", run);
	if (!existsSync(source)) throw new Error(`Run ${run} not found; run eval first.`);
	for (const required of [
		"manifest.json",
		"cases.json",
		"summary.json",
		"report.md",
		"scoring-plan.json",
		"plan.json",
	]) {
		if (!existsSync(join(source, required))) throw new Error(`Run ${run} is incomplete: ${required} is missing.`);
	}
	if (containsCredential(source))
		throw new Error(`Run ${run} contains credential-like material; redact and rerun before promotion.`);
	const gatesPath = join(root, "evals/gates.json");
	const plan = readJson<RunPlan>(join(source, "plan.json"));
	const scoring = readJson<ScoringPlan>(join(source, "scoring-plan.json"));
	if (plan.schemaVersion !== 1 || canonicalJson(plan.scoring) !== canonicalJson(scoring))
		throw new Error("Frozen plan and scoring policy disagree; restore the original artifacts before promotion.");
	assertPromotableSummary(readJson<FrozenSummary>(join(source, "summary.json")), scoring);
	const records = readFileSync(join(source, "trials.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TrialRecord);
	const slots = new Set<string>();
	for (const record of records) {
		const descriptor = plan.cases.find((item) => item.id === record.caseId);
		const slot = `${record.caseId}-${record.trial}`;
		if (
			!descriptor ||
			record.runId !== run ||
			record.caseHash !== descriptor.caseHash ||
			record.schemaVersion !== 5 ||
			!record.result ||
			record.archiveComplete !== true ||
			!Number.isInteger(record.trial) ||
			record.trial < 1 ||
			record.trial > (scoring.plannedTrials[record.caseId] ?? 0) ||
			slots.has(slot)
		)
			throw new Error("Invalid or incomplete trial evidence; restore the frozen trial records before promotion.");
		slots.add(slot);
		const trialDir = join(source, "trials", slot);
		const index = verifyArtifacts(trialDir);
		for (const file of ["record.json", "trace.jsonl", "outcome.json", "grades.json", "agent-usage.json"])
			if (!index.entries.some((entry) => entry.path === file && entry.status === "complete"))
				throw new Error(`Unsealed ${file}; finish evidence capture before promotion.`);
		if (canonicalJson(record) !== canonicalJson(readJson<TrialRecord>(join(trialDir, "record.json"))))
			throw new Error("Trial index differs from its sealed record; restore original evidence before promotion.");
	}
	const recomputed = summarize(records, plan.cases, scoring.gates, scoring.plannedTrials);
	assertPromotableSummary({ schemaVersion: 2, cases: recomputed }, scoring);
	if (canonicalJson(recomputed) !== canonicalJson(readJson<FrozenSummary>(join(source, "summary.json")).cases))
		throw new Error("Summary differs from trial evidence; regenerate the report before promotion.");
	const gatesBefore = hashFile(gatesPath);
	const target = join(root, "evals/baselines", run);
	if (existsSync(target)) throw new Error(`Baseline ${run} already exists; baselines are immutable.`);
	const staging = `${target}.pending`;
	if (existsSync(staging))
		throw new Error("An interrupted promotion exists; inspect and remove its .pending directory before retrying.");
	mkdirSync(staging, { recursive: true });
	try {
		for (const file of [
			"manifest.json",
			"cases.json",
			"summary.json",
			"report.md",
			"scoring-plan.json",
			"plan.json",
			"trials.jsonl",
			"human-review.jsonl",
			"human-review-sample.json",
		])
			if (existsSync(join(source, file))) copyFileSync(join(source, file), join(staging, file));
		for (const slot of slots)
			cpSync(join(source, "trials", slot), join(staging, "trials", slot), { recursive: true });
		for (const slot of slots) verifyArtifacts(join(staging, "trials", slot));
		writeFileSync(
			join(staging, "baseline.json"),
			`${JSON.stringify({ schemaVersion: 2, runId: run, promotedAt: new Date().toISOString() }, null, 2)}\n`,
		);
		renameSync(staging, target);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
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
