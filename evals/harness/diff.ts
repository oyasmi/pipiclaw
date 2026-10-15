import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionState } from "./execution-state.js";
import { canonicalJson } from "./fingerprint.js";
import type { CaseDescriptor, CaseSummary, RunManifest, RunPlan } from "./schema.js";
import { formatWilson } from "./statistics.js";

export type Experiment = "none" | "runtime" | "model";
export interface ComparisonEvidence {
	leftCases: CaseDescriptor[];
	rightCases: CaseDescriptor[];
	leftPlan?: RunPlan;
	rightPlan?: RunPlan;
	experiment?: Experiment;
	leftExecution?: ExecutionState;
	rightExecution?: ExecutionState;
}

function runDir(run: string, root = process.cwd()): string {
	if (run === "baseline" || run === "latest") {
		const latest = JSON.parse(readFileSync(join(root, "evals/baselines/latest.json"), "utf8")) as { runId: string };
		return join(root, "evals/baselines", latest.runId);
	}
	for (const parent of ["results", "baselines", "results/references"]) {
		const candidate = join(root, "evals", parent, run);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`Run ${run} not found; run eval or promote a baseline first.`);
}

export function compareRuns(
	root: string,
	leftName: string,
	rightName: string,
	experiment: Experiment = "none",
): string {
	const leftDir = runDir(leftName, root);
	const rightDir = runDir(rightName, root);
	return renderDiff(
		leftName,
		rightName,
		read<RunManifest>(leftDir, "manifest.json"),
		read<RunManifest>(rightDir, "manifest.json"),
		read<{ cases: CaseSummary[] }>(leftDir, "summary.json").cases,
		read<{ cases: CaseSummary[] }>(rightDir, "summary.json").cases,
		{
			leftExecution: existsSync(join(leftDir, "execution-state.json"))
				? read<ExecutionState>(leftDir, "execution-state.json")
				: undefined,
			rightExecution: existsSync(join(rightDir, "execution-state.json"))
				? read<ExecutionState>(rightDir, "execution-state.json")
				: undefined,
			leftCases: read<CaseDescriptor[]>(leftDir, "cases.json"),
			rightCases: read<CaseDescriptor[]>(rightDir, "cases.json"),
			leftPlan: existsSync(join(leftDir, "plan.json")) ? read<RunPlan>(leftDir, "plan.json") : undefined,
			rightPlan: existsSync(join(rightDir, "plan.json")) ? read<RunPlan>(rightDir, "plan.json") : undefined,
			experiment,
		},
	);
}

function read<T>(dir: string, file: string): T {
	return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
}

export function comparisonBlockers(a: RunManifest, b: RunManifest, evidence: ComparisonEvidence): string[] {
	const reasons: string[] = [];
	const same = (label: string, x: unknown, y: unknown) => {
		if (x === undefined || y === undefined || canonicalJson(x) !== canonicalJson(y)) reasons.push(label);
	};
	if (a.schemaVersion !== 2 || b.schemaVersion !== 2 || !evidence.leftPlan || !evidence.rightPlan)
		reasons.push("missing frozen plan / legacy measurement");
	if (evidence.leftExecution || evidence.rightExecution) {
		for (const state of [evidence.leftExecution, evidence.rightExecution])
			if (state?.status !== "stable" || state.expected !== state.observed)
				reasons.push("execution changed or unrecorded");
		if (evidence.experiment !== "runtime")
			same("compiled execution", evidence.leftExecution?.expected, evidence.rightExecution?.expected);
	}
	same("lockfile", a.lockfileHash, b.lockfileHash);
	same("harness schema", a.harnessSchemaVersions, b.harnessSchemaVersions);
	const policyA = evidence.leftPlan?.scoring;
	const policyB = evidence.rightPlan?.scoring;
	if (
		policyA?.judgePolicy !== policyB?.judgePolicy ||
		policyA?.judgeEnabled !== policyB?.judgeEnabled ||
		policyA?.mode !== policyB?.mode ||
		policyA?.maxInvalidShare !== policyB?.maxInvalidShare
	)
		reasons.push("acceptance / advisory policy");
	same("environment", a.environment, b.environment);
	same("thinking", a.thinkingLevel, b.thinkingLevel);
	if (
		policyA?.judgePolicy !== "advisory" ||
		policyB?.judgePolicy !== "advisory" ||
		policyA.judgeEnabled ||
		policyB.judgeEnabled
	)
		same("judge", a.profile?.judge, b.profile?.judge);
	if (evidence.experiment !== "runtime") {
		same("git", a.gitSha, b.gitSha);
		same("dirty diff", a.gitDirtyDiffHash, b.gitDirtyDiffHash);
	}
	if (evidence.experiment !== "model") {
		same("model", a.configuredModel, b.configuredModel);
		same("endpoint", a.providerEndpoint, b.providerEndpoint);
		same("model configuration", a.profile?.modelsHash, b.profile?.modelsHash);
	}
	for (const [manifest, plan] of [
		[a, evidence.leftPlan],
		[b, evidence.rightPlan],
	] as const) {
		if (!plan) continue;
		const frozen = {
			profile: plan.profile,
			gitSha: plan.gitSha,
			dirty: plan.gitDirtyDiffHash,
			lockfile: plan.lockfileHash,
			environment: plan.environment,
		};
		const actual = {
			profile: manifest.profile,
			gitSha: manifest.gitSha,
			dirty: manifest.gitDirtyDiffHash,
			lockfile: manifest.lockfileHash,
			environment: manifest.environment,
		};
		if (
			canonicalJson(frozen) !== canonicalJson(actual) ||
			manifest.configuredModel !== manifest.profile?.agent.resolved
		)
			reasons.push("manifest differs from frozen plan");
	}
	for (const manifest of [a, b]) {
		const expected = manifest.profile?.agent.resolved;
		if (
			manifest.observedModels?.some(
				(model) =>
					model !== "unknown" && model !== expected && model !== expected?.slice(expected.indexOf("/") + 1),
			)
		)
			reasons.push("observed model drift");
	}
	return [...new Set(reasons)];
}

function trialConditions(manifest: RunManifest, id: string): string[] {
	return [
		...new Set(
			Object.entries(manifest.trialConfigHashes ?? {})
				.filter(([key]) => key.startsWith(`${id}:`))
				.map(([, values]) => canonicalJson(values)),
		),
	].sort();
}

export function caseComparisonBlockers(
	id: string,
	a: RunManifest,
	b: RunManifest,
	x: CaseSummary | undefined,
	y: CaseSummary | undefined,
	evidence: ComparisonEvidence,
): string[] {
	const reasons = comparisonBlockers(a, b, evidence);
	const definitionA = evidence.leftCases.find((item) => item.id === id);
	const definitionB = evidence.rightCases.find((item) => item.id === id);
	if (!x) reasons.push("added");
	if (!y) reasons.push("removed");
	if (!x?.valid || !y?.valid) reasons.push("no scorable samples");
	if (x?.invalid || y?.invalid || x?.unknown || y?.unknown || x?.invariantUnknown || y?.invariantUnknown)
		reasons.push("incomplete outcome / invariant evidence");
	if (
		!definitionA ||
		!definitionB ||
		definitionA.schemaVersion !== 2 ||
		definitionB.schemaVersion !== 2 ||
		definitionA.caseHash !== definitionB.caseHash
	)
		reasons.push("case / oracle / fixture changed or missing");
	const seeds = (plan: RunPlan | undefined) =>
		Object.entries(plan?.fixtureSeeds ?? {}).filter(([key]) => key.startsWith(`${id}:`));
	if (
		!seeds(evidence.leftPlan).length ||
		canonicalJson(seeds(evidence.leftPlan)) !== canonicalJson(seeds(evidence.rightPlan))
	)
		reasons.push("fixture seeds");
	const conditionsA = trialConditions(a, id);
	const conditionsB = trialConditions(b, id);
	if (!conditionsA.length || !conditionsB.length || canonicalJson(conditionsA) !== canonicalJson(conditionsB))
		reasons.push("effective trial configuration");
	const planA = evidence.leftPlan?.scoring;
	const planB = evidence.rightPlan?.scoring;
	if (
		(planA?.judgePolicy === "advisory" || planB?.judgePolicy === "advisory") &&
		(planA?.oracleChecks?.[id]?.status !== "qualified" ||
			planB?.oracleChecks?.[id]?.status !== "qualified" ||
			canonicalJson(planA?.oracleChecks?.[id]) !== canonicalJson(planB?.oracleChecks?.[id]))
	)
		reasons.push("oracle qualification / controls changed");
	if (canonicalJson(evidence.leftPlan?.budgets[id]) !== canonicalJson(evidence.rightPlan?.budgets[id]))
		reasons.push("trial resource budget");
	if (
		!planA ||
		!planB ||
		canonicalJson(planA.gates[id] ?? null) !== canonicalJson(planB.gates[id] ?? null) ||
		planA.plannedTrials[id] !== planB.plannedTrials[id] ||
		x?.started !== planA.plannedTrials[id] ||
		y?.started !== planB.plannedTrials[id]
	)
		reasons.push("scoring policy / incomplete or unpaired plan");
	return [...new Set(reasons)];
}

export function renderDiff(
	leftName: string,
	rightName: string,
	a: RunManifest,
	b: RunManifest,
	left: CaseSummary[],
	right: CaseSummary[],
	evidence: ComparisonEvidence = { leftCases: [], rightCases: [] },
): string {
	const blockers = comparisonBlockers(a, b, evidence);
	const ids = [...new Set([...left, ...right].map((summary) => summary.caseId))].sort();
	const rows = ids.map((id) => {
		const x = left.find((summary) => summary.caseId === id);
		const y = right.find((summary) => summary.caseId === id);
		const reasons = caseComparisonBlockers(id, a, b, x, y, evidence);
		const rate = (value: CaseSummary | undefined) =>
			value ? `${value.passed}/${value.valid} (${formatWilson(value.passed, value.valid)})` : "—";
		if (reasons.length || !x || !y)
			return `| ${id} | ${rate(x)} | ${rate(y)} | N/A | N/A | N/A | ${[...new Set(reasons)].join("; ")} |`;
		const delta = (y.passed / y.valid - x.passed / x.valid) * 100;
		const cost = y.medianCostUsd - x.medianCostUsd;
		const costDelta =
			a.costBasis && a.costBasis === b.costBasis && !x.unknownCostSamples && !y.unknownCostSamples
				? `${cost >= 0 ? "+" : ""}$${cost.toFixed(4)}`
				: "N/A (cost basis)";
		return `| ${id} | ${rate(x)} | ${rate(y)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}pp | ${costDelta} | ${((y.medianWallMs - x.medianWallMs) / 1_000).toFixed(1)}s | descriptive only; inspect sample size |`;
	});
	return `# Eval diff ${leftName} → ${rightName}

Experiment: ${evidence.experiment ?? "none"}. Only this declared variable may change.
Started: ${a.startedAt} → ${b.startedAt}
Global controls: ${blockers.length ? blockers.join("; ") : "matched"}.
Reported deltas are descriptive, not evidence of statistical significance. Missing identities or historical plans cannot be repaired by relabelling a run.

| Case | A | B | Pass Δ | Median cost Δ | Median wall Δ | Evidence / limitation |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
${rows.join("\n")}
`;
}

const invokedAsScript = process.argv[1]?.endsWith("/diff.js") || process.argv[1]?.endsWith("\\diff.js");
if (invokedAsScript) {
	const [leftName, rightName, flag, variable] = process.argv.slice(2);
	if (
		!leftName ||
		!rightName ||
		(flag && flag !== "--experiment") ||
		(variable && !["none", "runtime", "model"].includes(variable)) ||
		(flag && !variable)
	)
		throw new Error("Use npm run eval:diff -- <runA> <runB|baseline> [--experiment none|runtime|model].");
	process.stdout.write(compareRuns(process.cwd(), leftName, rightName, variable as Experiment | undefined));
}
