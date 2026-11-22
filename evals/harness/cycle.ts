import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allCases } from "../cases/index.js";
import { atomicJson } from "./artifacts.js";
import { renderDiagnostics } from "./diagnostics.js";
import { caseComparisonBlockers, type Experiment, renderDiff } from "./diff.js";
import {
	assertPlanEnvelope,
	assertPlanIdentity,
	buildExecutionPlan,
	executionCases,
	loadExecutionPlan,
	planPath,
} from "./execution-plan.js";
import type { ExecutionState } from "./execution-state.js";
import { canonicalJson } from "./fingerprint.js";
import { assertPromotableSummary, promoteRun, validateBaselineEvidence } from "./promote.js";
import { regradeTrial } from "./regrade.js";
import { runMain } from "./run.js";
import type { CaseSummary, GradeResult, RunManifest, RunPlan, TrialRecord } from "./schema.js";
import { option } from "./selection.js";

function read<T>(dir: string, file: string): T {
	return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
}

function cyclePlan(args: string[]) {
	const planFile = option(args, "--plan");
	if (
		planFile &&
		args.some(
			(arg, index) =>
				!["--plan", "--experiment"].includes(arg) && !["--plan", "--experiment"].includes(args[index - 1] ?? ""),
		)
	)
		throw new Error(
			"A frozen plan only accepts --experiment at execution. Set selection and budgets in eval plan. Model requests: 0.",
		);
	const plan = planFile ? loadExecutionPlan(planPath(planFile)) : buildExecutionPlan(args);
	if (planFile) assertPlanIdentity(plan);
	const experiment = (option(args, "--experiment") ?? "none") as Experiment;
	if (!["none", "runtime", "model"].includes(experiment))
		throw new Error("--experiment must be none, runtime or model.");
	if (plan.judgeEnabled)
		throw new Error(
			"Autonomous cycles use objective oracles and a bounded agent budget. Use run --judge advisory for a separately budgeted opinion.",
		);
	return { plan, experiment, ...assertPlanEnvelope(executionCases(plan), plan.trials, plan.budgets) };
}

/** Replay saved evidence, never rerun a failed agent in place and never call a judge. */
export async function replayRun(dir: string): Promise<{ matched: number; total: number; errors: string[] }> {
	const records = readFileSync(join(dir, "trials.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TrialRecord);
	const errors: string[] = [];
	let matched = 0;
	const objective = (grades: GradeResult[]) =>
		grades
			.filter((grade) => grade.graderKind !== "model")
			.map(({ graderId, graderVersion, status, severity }) => ({ graderId, graderVersion, status, severity }));
	const started = records.filter((record) => record.observedModel !== "not-started");
	for (const record of started) {
		const slot = `${record.caseId}-${record.trial}`;
		try {
			const item = allCases.find((item) => item.id === record.caseId);
			if (!item) throw new Error("Case is absent from the current catalog");
			const assessment = await regradeTrial(join(dir, "trials", slot), item, join(dir, "replay", slot));
			const value = JSON.parse(readFileSync(assessment, "utf8")) as {
				originalCaseHash: string;
				graderCaseHash: string;
				result: TrialRecord["result"];
				grades: GradeResult[];
			};
			if (
				value.originalCaseHash !== value.graderCaseHash ||
				canonicalJson(value.result) !== canonicalJson(record.result) ||
				canonicalJson(objective(value.grades)) !== canonicalJson(objective(record.grades))
			)
				throw new Error("Replay changed the objective verdict, grader status or evaluator identity");
			matched++;
		} catch (error) {
			errors.push(`${slot}: ${String(error)}`);
		}
	}
	const result = { matched, total: started.length, errors };
	atomicJson(join(dir, "replay.json"), { schemaVersion: 1, agentRequests: 0, judgeRequests: 0, ...result });
	return result;
}

interface Measurement {
	manifest: RunManifest;
	plan: RunPlan;
	summaries: CaseSummary[];
}
function measurement(dir: string): Measurement {
	return {
		manifest: read(dir, "manifest.json"),
		plan: read(dir, "plan.json"),
		summaries: read<{ cases: CaseSummary[] }>(dir, "summary.json").cases,
	};
}

/** A previous baseline is an immutable reference; a worse later run never moves it. */
export function selectReference(
	root: string,
	currentDir: string,
	experiment: Experiment,
): { runId?: string; rejected: Array<{ runId: string; reasons: string[] }> } {
	const current = measurement(currentDir);
	const parent = join(root, "evals/results/references");
	const rejected: Array<{ runId: string; reasons: string[] }> = [];
	for (const entry of existsSync(parent)
		? readdirSync(parent, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.sort((a, b) => b.name.localeCompare(a.name))
		: []) {
		try {
			const dir = join(parent, entry.name);
			if (!existsSync(join(dir, "execution-state.json")))
				throw new Error("Reference predates frozen execution checks; collect a new supervised cycle");
			const previous = measurement(dir);
			if (previous.plan.scoring.judgePolicy !== "advisory" || !existsSync(join(dir, "cycle.json")))
				throw new Error("Historical or non-autonomous baseline has no sealed replay qualification");
			const cycle = read<{ exitCode: number; replay: { matched: number; total: number; errors: string[] } }>(
				dir,
				"cycle.json",
			);
			if (
				cycle.exitCode !== 0 ||
				!cycle.replay.total ||
				cycle.replay.matched !== cycle.replay.total ||
				cycle.replay.errors.length
			)
				throw new Error("Reference failed its objective or replay checks");
			if (previous.summaries.some((item) => item.invalid || item.unknown || item.invariantUnknown))
				throw new Error("Reference contains unresolved outcome evidence");
			const sealed = validateBaselineEvidence(dir, entry.name);
			if (cycle.replay.total !== sealed.records.length)
				throw new Error("Replay count differs from sealed trial evidence");
			const evidence = {
				leftExecution: read<ExecutionState>(dir, "execution-state.json"),
				rightExecution: existsSync(join(currentDir, "execution-state.json"))
					? read<ExecutionState>(currentDir, "execution-state.json")
					: undefined,
				leftCases: previous.plan.cases,
				rightCases: current.plan.cases,
				leftPlan: previous.plan,
				rightPlan: current.plan,
				experiment,
			};
			const ids = [...new Set([...previous.summaries, ...current.summaries].map((item) => item.caseId))];
			const reasons = [
				...new Set(
					ids.flatMap((id) =>
						caseComparisonBlockers(
							id,
							previous.manifest,
							current.manifest,
							previous.summaries.find((item) => item.caseId === id),
							current.summaries.find((item) => item.caseId === id),
							evidence,
						),
					),
				),
			];
			if (!reasons.length) return { runId: entry.name, rejected };
			rejected.push({ runId: entry.name, reasons });
		} catch (error) {
			rejected.push({ runId: entry.name, reasons: [String(error)] });
		}
	}
	return { rejected };
}

export async function runCycle(args: string[]): Promise<void> {
	const envelope = cyclePlan(args);
	const { plan } = envelope;
	if (!plan.slots.length) {
		process.stdout.write(`Eval plan is empty (${plan.emptyReason ?? "no cases"}). Model requests: 0.\n`);
		return;
	}
	const completed = await runMain([], plan);
	const dir = completed.resultDir;
	if (!existsSync(join(dir, "trials.jsonl"))) return;
	writeFileSync(join(dir, "diagnostics.md"), `${renderDiagnostics(process.cwd(), completed.runId)}\n`);
	const replay = await replayRun(dir);
	const current = measurement(dir);
	let exitCode = completed.exitCode;
	if (replay.errors.length && exitCode !== 1) exitCode = 2;
	const reference = selectReference(process.cwd(), dir, envelope.experiment);
	if (reference.runId) {
		const previous = measurement(join(process.cwd(), "evals/results/references", reference.runId));
		writeFileSync(
			join(dir, "comparison.md"),
			renderDiff(
				reference.runId,
				completed.runId,
				previous.manifest,
				current.manifest,
				previous.summaries,
				current.summaries,
				{
					leftExecution: read<ExecutionState>(
						join(process.cwd(), "evals/results/references", reference.runId),
						"execution-state.json",
					),
					rightExecution: read<ExecutionState>(dir, "execution-state.json"),
					leftCases: previous.plan.cases,
					rightCases: current.plan.cases,
					leftPlan: previous.plan,
					rightPlan: current.plan,
					experiment: envelope.experiment,
				},
			),
		);
	}
	let referenceAction = reference.runId
		? `Compared against ${reference.runId}; the reference remains unchanged.`
		: "No compatible reference; no regression delta claimed.";
	let baselineEligible = false;
	if (exitCode === 0 && !reference.runId) {
		try {
			assertPromotableSummary({ schemaVersion: 2, cases: current.summaries }, current.plan.scoring);
			if (current.summaries.some((item) => item.invalid || item.unknown || item.invariantUnknown))
				throw new Error("Unavailable outcomes prevent automatic reference capture");
			baselineEligible = true;
		} catch (error) {
			referenceAction += ` Reference not established: ${String(error)}`;
		}
	}
	atomicJson(join(dir, "cycle.json"), {
		schemaVersion: 1,
		exitCode,
		envelope: {
			maxCostUsd: envelope.maxCostUsd,
			maxWallMs: envelope.maxWallMs,
			agentCeilingUsd: envelope.agentCeilingUsd,
			wallCeilingMs: envelope.wallCeilingMs,
		},
		replay,
		reference,
		experiment: envelope.experiment,
	});
	if (baselineEligible) {
		try {
			promoteRun(process.cwd(), completed.runId, { automatic: true });
			referenceAction = `Established immutable reference ${completed.runId}; future compatible cycles compare automatically.`;
		} catch (error) {
			exitCode = 2;
			referenceAction = `Reference capture failed: ${String(error)}. Original results are preserved.`;
		}
	}
	const counts = current.summaries.reduce(
		(total, item) => ({
			passed: total.passed + item.passed,
			started: total.started + (item.started ?? 0),
			failed: total.failed + (item.valid - item.passed),
			unknown: total.unknown + item.invalid,
			notStarted: total.notStarted + (item.planned ?? 0) - (item.started ?? 0),
		}),
		{ passed: 0, started: 0, failed: 0, unknown: 0, notStarted: 0 },
	);
	const cycleReport = [
		`# ${exitCode === 0 ? (counts.failed ? "PASS WITH FINDINGS" : "PASS") : exitCode === 1 ? "FAIL" : "INCONCLUSIVE"} — autonomous cycle ${completed.runId}`,
		"",
		`${counts.passed}/${counts.started} trials passed; ${counts.failed} known failures; ${counts.unknown} started trials unavailable; ${counts.notStarted} not started. Frozen policy exit ${completed.exitCode}.`,
		`Offline evidence replay ${replay.matched}/${replay.total}; model calls during replay: 0.`,
		referenceAction,
		"",
		"[Run summary](report.md) · [Automatic diagnosis](diagnostics.md) · [Replay](replay.json)" +
			(reference.runId ? " · [Paired comparison](comparison.md)" : ""),
		...replay.errors.slice(0, 3).map((error) => `- ${error}`),
		"",
		"Qualification covers declared counterexamples. Small samples do not establish general model reliability. No human labels or approval are required.",
		"",
	].join("\n");
	writeFileSync(join(dir, "cycle.md"), cycleReport);
	const cycleRecord = read<Record<string, unknown>>(dir, "cycle.json");
	atomicJson(join(dir, "cycle.json"), { ...cycleRecord, exitCode, counts, referenceAction });
	process.stdout.write(`${cycleReport}\nCycle report: ${join(dir, "cycle.md")}\nExit: ${exitCode}\n`);
	process.exitCode = exitCode;
}
