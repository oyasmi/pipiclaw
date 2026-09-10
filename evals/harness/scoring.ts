import type {
	CaseSummary,
	EvalCase,
	GateRule,
	GradeResult,
	Grader,
	Outcome,
	ScoringPlan,
	TraceEvent,
	TrialContext,
	TrialRecord,
	TrialResult,
} from "./schema.js";
import { median, parseRatio } from "./util.js";

/** Observe SDK message status, never infer availability from the assistant's prose. */
export function modelResultFields(event: unknown): Record<string, string> | undefined {
	if (
		!event ||
		typeof event !== "object" ||
		!("type" in event) ||
		event.type !== "message_end" ||
		!("message" in event)
	)
		return;
	const message = event.message;
	if (
		!message ||
		typeof message !== "object" ||
		!("role" in message) ||
		message.role !== "assistant" ||
		!("stopReason" in message)
	)
		return;
	if (typeof message.stopReason !== "string") return;
	return { stopReason: message.stopReason };
}

/** Retries can repair a call within one scenario step, never erase an earlier step's fault. */
export function terminalModelFailure(trace: TraceEvent[]): TraceEvent | undefined {
	const lastByStep = new Map<string, TraceEvent>();
	let step = 0;
	for (const event of trace) {
		if (event.kind === "step") step = event.seq;
		if (event.kind === "model-result") lastByStep.set(`${event.segment}:${step}`, event);
	}
	return [...lastByStep.values()].find(
		(event) => event.fields?.stopReason === "error" || event.fields?.stopReason === "aborted",
	);
}

export async function gradeTrial(
	item: EvalCase,
	context: TrialContext,
	execution: TrialResult["execution"],
	judge: (grader: Extract<EvalCase["graders"][number], { kind: "model" }>) => Promise<GradeResult>,
): Promise<GradeResult[]> {
	const grades: GradeResult[] = [];
	// Always evaluate invariants first, even when execution was interrupted.
	const invariants = new Set<Grader>([
		...(item.invariants ?? []),
		...item.graders.filter((grader) => grader.severity === "hard-invariant"),
	]);
	const graders = [...invariants, ...item.graders.filter((grader) => !invariants.has(grader))];
	for (const grader of graders) {
		const severity = invariants.has(grader) ? "hard-invariant" : (grader.severity ?? "quality");
		try {
			const grade =
				grader.kind === "model" && execution !== "completed"
					? {
							schemaVersion: 1 as const,
							graderId: grader.graderId,
							graderVersion: grader.graderVersion,
							status: "skipped" as const,
							severity,
							evidence: [],
							rationale: "Execution interrupted; inspect captured evidence before regrading.",
						}
					: grader.kind === "model"
						? await judge(grader)
						: await grader.grade(context);
			grades.push({ ...grade, severity, graderKind: grader.kind ?? "code" });
		} catch (error) {
			grades.push({
				schemaVersion: 1,
				graderId: grader.graderId,
				graderVersion: grader.graderVersion,
				graderKind: grader.kind ?? "code",
				status: "error",
				severity,
				evidence: [],
				rationale: `${String(error)}; inspect the evidence and repair this grader before regrading.`,
			});
		}
	}
	return grades;
}

export function assessTrial(
	grades: GradeResult[],
	execution: TrialResult["execution"],
	evidenceComplete: boolean,
	stopReason?: TrialResult["stopReason"],
): TrialResult {
	const invariant = grades.filter((grade) => grade.severity === "hard-invariant");
	const acceptance = grades.filter((grade) => grade.severity !== "hard-invariant");
	const incomplete = (grade: GradeResult) => grade.status === "error" || grade.status === "skipped";
	return {
		execution,
		acceptance:
			execution === "agent-limit" || acceptance.some((grade) => grade.status === "fail")
				? "fail"
				: execution !== "completed" || !acceptance.length || acceptance.some(incomplete)
					? "unknown"
					: "pass",
		invariants: invariant.some((grade) => grade.status === "fail")
			? "violated"
			: !evidenceComplete || invariant.some(incomplete)
				? "unknown"
				: "intact",
		grading: grades.some(incomplete) ? (grades.every(incomplete) ? "error" : "partial") : "complete",
		evidenceComplete,
		stopReason,
	};
}

export function resultOutcome(result: TrialResult): Outcome {
	if (result.invariants === "violated") return "invariant-violation";
	if (result.execution === "agent-limit") return "budget-exceeded";
	if (result.acceptance === "fail") return "fail";
	if (result.acceptance === "unknown" || result.invariants === "unknown") return "invalid";
	return "pass";
}

export function summarize(
	records: TrialRecord[],
	cases: Array<Pick<EvalCase, "id" | "suite" | "trials">>,
	gates: Record<string, GateRule>,
	plannedTrials?: Record<string, number>,
): CaseSummary[] {
	return cases.map((item) => {
		const entries = records.filter((record) => record.caseId === item.id);
		const valid = entries.filter((record) =>
			record.result
				? record.result.execution === "agent-limit" ||
					(record.result.acceptance !== "unknown" && resultOutcome(record.result) !== "invalid")
				: record.outcome !== "invalid",
		);
		return {
			caseId: item.id,
			suite: item.suite,
			gate: gates[item.id]?.gate ?? "report-only",
			passed: entries.filter((record) =>
				record.result ? resultOutcome(record.result) === "pass" : record.outcome === "pass",
			).length,
			valid: valid.length,
			invalid: entries.length - valid.length,
			planned: plannedTrials?.[item.id] ?? item.trials ?? 3,
			started: entries.length,
			unknown: entries.filter((record) =>
				record.result ? record.result.acceptance === "unknown" : record.outcome === "invalid",
			).length,
			invariantViolations: entries.filter(
				(record) =>
					record.result?.invariants === "violated" ||
					record.outcome === "invariant-violation" ||
					record.grades.some((grade) => grade.severity === "hard-invariant" && grade.status === "fail"),
			).length,
			invariantUnknown: entries.filter(
				(record) => record.result?.invariants === "unknown" || (!record.result && record.outcome === "invalid"),
			).length,
			budgetExceeded: entries.filter(
				(record) => record.result?.execution === "agent-limit" || record.outcome === "budget-exceeded",
			).length,
			unknownCostSamples: entries.filter((record) => record.resources?.agentCostUsd === null).length,
			medianCostUsd: median(entries.map((record) => record.metrics.costUsd)),
			medianWallMs: median(entries.map((record) => record.metrics.wallMs)),
			medianToolCalls: median(entries.map((record) => record.metrics.toolCalls)),
		};
	});
}

/** Shared by execution and promotion. A known violation outranks sample-health failures. */
export function evaluateSummary(cases: CaseSummary[], plan: ScoringPlan): { code: 0 | 1 | 2; reason: string } {
	const fail = (code: 1 | 2, reason: string) => ({ code, reason });
	if (cases.some((item) => (item.invariantViolations ?? 0) > 0))
		return fail(1, "Hard invariant violated; inspect its evidence before another run.");
	if (!Object.keys(plan.plannedTrials).length) return fail(2, "Empty plan; select cases and run again.");
	for (const [id, count] of Object.entries(plan.plannedTrials)) {
		const item = cases.find((candidate) => candidate.caseId === id);
		if (
			!Number.isInteger(count) ||
			count < 1 ||
			!item ||
			item.started !== count ||
			item.planned !== count ||
			item.invariantViolations === undefined ||
			item.invariantUnknown === undefined
		)
			return fail(2, `Incomplete plan for ${id}; finish the planned trials.`);
		const rule = plan.gates[id];
		if (rule?.gate !== "required") continue;
		const ratio = rule.minPass ? parseRatio(rule.minPass) : { passed: 1, total: 1 };
		const minSamples = rule.minSamples ?? ratio.total;
		if (!Number.isInteger(minSamples) || minSamples < 1)
			return fail(2, `Invalid minSamples for ${id}; set a positive integer before running.`);
		if (item.valid < minSamples)
			return fail(
				2,
				`Insufficient evidence for required case ${id}; collect the declared samples and invariant evidence.`,
			);
		if (item.passed < Math.ceil((ratio.passed / ratio.total) * item.valid))
			return fail(1, `Run misses required gate ${id}; inspect failed trials before promotion.`);
		if (item.invariantUnknown)
			return fail(2, `Unknown invariant evidence for ${id}; inspect captured evidence before promotion.`);
	}
	const total = cases.reduce((sum, item) => sum + (item.started ?? 0), 0);
	if (!total || cases.reduce((sum, item) => sum + item.invalid, 0) / total > plan.maxInvalidShare)
		return fail(2, "Run is inconclusive; resolve unavailable evidence before promotion.");
	return { code: 0, reason: "Frozen scoring policy satisfied." };
}
