import { humanReviewCalibration } from "./review-history.js";
import type { CaseSummary, HumanReviewRecord, RunManifest, ScoringPlan, TrialRecord } from "./schema.js";
import { evaluateSummary } from "./scoring.js";
import { formatWilson } from "./statistics.js";
import { FALLBACK_TOKEN_RATES_USD_PER_MTOK } from "./util.js";

export function renderDetailedReport(
	manifest: RunManifest,
	summaries: CaseSummary[],
	records: TrialRecord[],
	reviews: HumanReviewRecord[] = [],
	plan?: ScoringPlan,
): string {
	const quarantine = summaries.filter((summary) => summary.gate === "quarantine");
	const invariantFailures = records.flatMap((record) =>
		record.grades
			.filter((grade) => grade.severity === "hard-invariant" && grade.status === "fail")
			.map((grade) => `${record.caseId}#${record.trial}: ${grade.graderId} — ${grade.rationale}`),
	);
	const rows = summaries.map(
		(summary) =>
			`| ${summary.caseId} | ${summary.suite} | ${summary.passed}/${summary.valid} | ${formatWilson(summary.passed, summary.valid)} | ${summary.invalid} | ${summary.budgetExceeded} | ${summary.gate} | ${summary.unknownCostSamples ? "N/A (unknown cost)" : `$${summary.medianCostUsd.toFixed(4)}`} | ${(summary.medianWallMs / 1_000).toFixed(1)}s | ${summary.medianToolCalls} |`,
	);
	const unknownCostTrials = records.filter((record) => record.resources?.agentCostUsd === null).length;
	const totalCost = records.reduce((sum, record) => sum + record.metrics.costUsd, 0);
	const tokens = records.reduce((sum, record) => sum + record.metrics.tokens.total, 0);
	const scored = summaries.filter((summary) => summary.valid > 0);
	const perfect = scored.filter((summary) => summary.passed === summary.valid).length;
	const allPassRatio = scored.length ? perfect / scored.length : 0;
	const failures = records
		.filter((record) => record.outcome !== "pass")
		.map((record) => {
			const reasons = record.grades
				.filter((grade) => grade.status === "fail" || grade.status === "error")
				.map((grade) => `${grade.graderId}: ${grade.rationale}`.replace(/\s+/g, " ").slice(0, 300));
			return `- ${record.caseId}#${record.trial} (${record.outcome}): ${reasons.join("; ") || "no failing grader recorded"}`;
		});
	const calibration = humanReviewCalibration(records, reviews);
	const observedModels = [...new Set(records.map((record) => record.observedModel))].sort();
	const suites = [...new Set(summaries.map((summary) => summary.suite))].map((suite) => {
		const items = summaries.filter((summary) => summary.suite === suite);
		return `| ${suite} | ${items.reduce((sum, item) => sum + item.passed, 0)}/${items.reduce((sum, item) => sum + item.valid, 0)} | ${items.reduce((sum, item) => sum + item.invalid, 0)} | ${items.reduce((sum, item) => sum + item.budgetExceeded, 0)} |`;
	});
	const advisoryFlags = records.flatMap((record) =>
		record.grades
			.filter((grade) => grade.authority === "advisory" && ["fail", "error"].includes(grade.status))
			.map(
				(grade) =>
					`- ${record.caseId}#${record.trial} ${grade.graderId}: ${grade.rationale.replace(/\s+/g, " ").slice(0, 600)}. [Evidence](trials/${record.caseId}-${record.trial}/record.json)`,
			),
	);
	const rates = FALLBACK_TOKEN_RATES_USD_PER_MTOK;
	const costNote =
		manifest.costBasis === "provider"
			? "provider-reported"
			: `${manifest.costBasis ?? "unknown"} — figures priced at the harness rate card ($${rates.input}/$${rates.output} per Mtok in/out); comparable across runs, not an invoice`;
	return `# Behavior evaluation ${manifest.runId}

Started: ${manifest.startedAt}\x20\x20
Configured model: ${manifest.configuredModel}\x20\x20
Observed model(s): ${observedModels.join(", ") || "unknown"}\x20\x20
Judge: ${manifest.judgeModel ?? "unknown"}
Trials: ${records.length}; ${unknownCostTrials ? `known cost subtotal: $${totalCost.toFixed(4)}; ${unknownCostTrials} trial(s) have unknown total cost` : `cost: $${totalCost.toFixed(4)} (${costNote})`}; tokens: ${tokens}
Discrimination: ${perfect}/${scored.length} cases passed every valid trial (${(allPassRatio * 100).toFixed(0)}%). A high pass rate alone does not measure probe sensitivity; inspect declared positive, negative and equivalence controls.

Objective verdict: code oracles decide acceptance. Model judging is ${plan?.judgeEnabled ? "enabled as advisory only" : "disabled or historical"}; model agreement is not a correctness certificate.
${reviews.length ? `Historical model-grader calibration: ${calibration.agreed}/${calibration.reviewed} (${((calibration.agreement ?? 0) * 100).toFixed(0)}%); false-pass ${calibration.falsePass}, false-fail ${calibration.falseFail}. Historical labels do not authorize new runs.` : ""}

## Resources

${
	records
		.filter((record) => record.resources)
		.map(
			(record) =>
				`- ${record.caseId}#${record.trial}: ${Object.entries(record.resources!.byKind)
					.map(
						([kind, usage]) =>
							`${kind} ${usage.tokens.total} tokens, $${usage.knownCostUsd.toFixed(4)} known, ${usage.unknownCostEntries} unknown cost entries${usage.reconstructedTokenTotals ? `, ${usage.reconstructedTokenTotals} token totals derived from known components` : ""}`,
					)
					.join(
						"; ",
					)}; normalized units ${record.resources!.standardizedCostUnits.toFixed(4)} (not USD); agent ${record.metrics.agentWallMs ?? record.metrics.wallMs}ms, grading ${record.metrics.gradeWallMs ?? "unknown"}ms, queue ${record.metrics.queueWallMs ?? "unknown"}ms; judge known cost $${record.grades.reduce((sum, grade) => sum + Object.values(grade.resources?.byKind ?? {}).reduce((value, entry) => value + entry.knownCostUsd, 0), 0).toFixed(4)} (separate from agent; ${record.grades.filter((grade) => grade.graderKind === "model" && grade.status !== "skipped" && (!grade.resources || grade.resources.agentCostUsd === null)).length} judge totals unknown)`,
		)
		.join("\n") || "Historical resource breakdown unavailable."
}

## Suites

| Suite | Pass | Invalid | Budget-stopped |
| --- | ---: | ---: | ---: |
${suites.join("\n")}

## Quarantine

${quarantine.length ? quarantine.map((item) => `- ${item.caseId}: ${item.passed}/${item.valid} (${item.invalid} invalid)`).join("\n") : "None."}

## Advisory flags

${advisoryFlags.length ? advisoryFlags.join("\n") : "None. Disabled judges make no requests and have no unknown spend."}

## Hard invariant failures

${invariantFailures.length ? invariantFailures.map((item) => `- ${item}`).join("\n") : "None."}

## Failures

${failures.length ? failures.join("\n") : "None."}

## Results

| Case | Suite | Pass | Wilson 95% CI | Invalid | Budget | Gate | Median cost | Median wall | Median tools |
| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |
${rows.join("\n")}

${plan?.mode === "smoke" ? "Smoke scoring: every planned trial must finish with acceptance and invariant evidence. Known failures exit 1; unavailable evidence exits 2. Smoke runs cannot establish a baseline, regardless of sample count." : summaries.every((item) => item.planned !== undefined) ? "Agent resource limits count as behavioral failures. Cost and latency medians include all started trials. Required cases need the frozen minimum sample count; incomplete plans or unknown invariant evidence are inconclusive (exit 2). Known hard violations, including quarantine, and required gate misses exit 1." : "Historical scoring: archived denominators and medians are preserved. These summaries cannot establish a baseline under the current scoring policy; run the current evaluator for comparable measurements."}

${summaries.map((item) => `- ${item.caseId}: finished ${item.started ?? "unknown"}/${item.planned ?? "unknown"}; acceptance unknown ${item.unknown ?? "unknown"}; invariant violations ${item.invariantViolations ?? "unknown"}, unknown ${item.invariantUnknown ?? "unknown"}; success bounds ${item.started ? `${item.passed}/${item.started}–${item.passed + (item.unknown ?? 0)}/${item.started}` : "N/A"}`).join("\n")}

`;
}

function short(value: string, limit = 180): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** Execution availability takes precedence over missing-output graders caused by that failure. */
export function trialCategory(record: TrialRecord): "pass" | "safety" | "behavior" | "unavailable" {
	if (record.result?.invariants === "violated" || record.outcome === "invariant-violation") return "safety";
	if (record.result && !["completed", "agent-limit"].includes(record.result.execution)) return "unavailable";
	if (record.outcome === "invalid") return "unavailable";
	return record.outcome === "pass" ? "pass" : "behavior";
}

export function renderReport(
	manifest: RunManifest,
	summaries: CaseSummary[],
	records: TrialRecord[],
	_reviews: HumanReviewRecord[] = [],
	plan?: ScoringPlan,
	archiveProblem = false,
): string {
	const decision = plan ? evaluateSummary(summaries, plan) : undefined;
	const counts = { pass: 0, safety: 0, behavior: 0, unavailable: 0 };
	for (const record of records) counts[trialCategory(record)]++;
	const planned = plan ? Object.values(plan.plannedTrials).reduce((sum, n) => sum + n, 0) : undefined;
	const status =
		counts.safety || decision?.code === 1
			? "FAIL"
			: archiveProblem || counts.unavailable || decision?.code === 2
				? "INCONCLUSIVE"
				: counts.behavior
					? "FINDINGS"
					: !plan
						? "HISTORICAL"
						: plan.mode === "smoke"
							? "SMOKE PASS"
							: "GATES PASS";
	const wall = manifest.finishedAt
		? `${((Date.parse(manifest.finishedAt) - Date.parse(manifest.startedAt)) / 60000).toFixed(1)} min`
		: "unavailable (historical)";
	const agentKnown = records.reduce((sum, record) => sum + record.metrics.costUsd, 0);
	const agentUnknown = records.filter((record) => !record.resources || record.resources.agentCostUsd === null).length;
	const judges = records.flatMap((record) =>
		record.grades.filter((grade) => grade.graderKind === "model" && grade.status !== "skipped"),
	);
	const judgeKnown = judges.reduce(
		(sum, grade) =>
			sum + Object.values(grade.resources?.byKind ?? {}).reduce((n, account) => n + account.knownCostUsd, 0),
		0,
	);
	const judgeUnknown = judges.filter((grade) => !grade.resources || grade.resources.agentCostUsd === null).length;
	const groups = new Map<string, TrialRecord[]>();
	for (const record of records.filter((record) => trialCategory(record) !== "pass")) {
		const stop = record.result?.stopReason;
		const grade = record.grades.find(
			(grade) => grade.authority !== "advisory" && (grade.status === "fail" || grade.status === "error"),
		);
		const key = `${record.caseId}:${trialCategory(record)}:${stop?.code ?? grade?.graderId ?? record.outcome}`;
		const group = groups.get(key) ?? [];
		group.push(record);
		groups.set(key, group);
	}
	const priority = { safety: 0, unavailable: 1, behavior: 2, pass: 3 };
	const issues = [...groups.values()].sort((a, b) => priority[trialCategory(a[0]!)] - priority[trialCategory(b[0]!)]);
	const lines = [
		`# ${status} — ${manifest.runId}`,
		"",
		`${records.length}/${planned ?? "unknown"} planned trials; ${counts.pass} passed, ${counts.behavior} behavioral failures, ${counts.safety} safety violations, ${counts.unavailable} unavailable.`,
		`Coverage: ${summaries.length} cases${summaries.length <= 12 ? ` (${summaries.map((item) => item.caseId).join(", ")})` : "; see details"}.`,
		`Model: ${manifest.configuredModel}; thinking: ${manifest.thinkingLevel ?? "unknown"}; elapsed: ${wall}.`,
		`Agent recorded subtotal: $${agentKnown.toFixed(4)} (${manifest.costBasis ?? "unknown basis"}; ${agentUnknown} totals unknown); judge known subtotal: $${judgeKnown.toFixed(4)} (${judgeUnknown} totals unknown).`,
		`Conclusion: ${decision?.reason ?? "Archived results; no frozen scoring plan supplied."}`,
		...(archiveProblem
			? [
					"Archive incomplete or credential scan failed; inspect interrupted.json / credential-scan-failure.txt before reuse.",
				]
			: []),
		...(plan?.mode === "smoke"
			? ["Smoke probes detect obvious failures; they cannot establish release quality or a baseline."]
			: []),
		"",
		"## Next actions",
		"",
	];
	if (!issues.length)
		lines.push(
			plan?.mode === "smoke"
				? "No failed trials. Run `npm run eval -- run --profile core` when a baseline decision is needed."
				: "No failed trials. Inspect paired comparability before drawing a regression conclusion.",
		);
	for (const group of issues.slice(0, 5)) {
		const record = group[0]!;
		const category = trialCategory(record);
		const stop = record.result?.stopReason;
		const grade = record.grades.find(
			(grade) =>
				grade.authority !== "advisory" &&
				(category !== "safety" || grade.severity === "hard-invariant") &&
				["fail", "error"].includes(grade.status),
		);
		const reason = stop
			? `${record.result?.execution}: ${stop.source}/${stop.code}`
			: `${grade?.graderId ?? record.outcome}: ${short(grade?.rationale ?? "Inspect record.json")}`;
		const slot = `${record.caseId}-${record.trial}`;
		lines.push(
			`- ${record.caseId}: ${category}, ${group.length} trial(s). ${reason}. [Evidence](trials/${slot}/record.json)`,
		);
		lines.push(
			`  Evidence ref: ${short(stop?.evidenceId ?? grade?.evidence.map((entry) => entry.ref).join(", ") ?? "record.json")}.`,
		);
		lines.push(`  Reproduce: \`npm run eval -- run --case ${record.caseId} --profile dev\``);
	}
	if (issues.length > 5)
		lines.push(`Further ${issues.length - 5} issue groups: \`npm run eval -- diagnose ${manifest.runId}\`.`);
	if (planned !== undefined && records.length < planned)
		lines.push(`Incomplete plan: inspect interrupted.json, then \`npm run eval -- resume ${manifest.runId}\`.`);
	lines.push(
		"",
		`Oracle checks: ${plan?.oracleChecks ? `${Object.values(plan.oracleChecks).filter((entry) => entry.status === "qualified").length}/${Object.keys(plan.oracleChecks).length} cases qualified; see oracle-checks/oracle-checks.json` : "not available for this historical run"}.`,
		`Advisory judge: ${plan?.judgeEnabled ? `${judges.filter((grade) => grade.status !== "skipped").length} opinions; ${judges.filter((grade) => grade.status === "fail" || grade.status === "error").length} flags (never change the objective verdict)` : "off; no human labels required"}.`,
		"",
		"[Full results, confidence intervals, resources and oracle evidence](details.md). Raw evidence: trials.jsonl and trials/.",
		"",
	);
	return lines.join("\n");
}
