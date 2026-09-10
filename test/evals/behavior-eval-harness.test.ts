import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedChannelMemory } from "../../evals/cases/helpers.js";
import { allCases } from "../../evals/cases/index.js";
import { captureArtifacts, sealArtifactIndex, verifyArtifacts } from "../../evals/harness/artifacts.js";
import { caseHash, validateCases } from "../../evals/harness/cases.js";
import { renderDiff } from "../../evals/harness/diff.js";
import { lastDeliveryMatches, noDeliveriesAfterStep, recallQuiz } from "../../evals/harness/graders.js";
import { assertPromotableSummary, promoteRun } from "../../evals/harness/promote.js";
import { rerenderReport } from "../../evals/harness/report.js";
import {
	exceededBudgetReason,
	gitDirtyFingerprint,
	humanReviewCalibration,
	renderReport,
	runWorkerSegment,
	segmentScript,
} from "../../evals/harness/run.js";
import type {
	CaseSummary,
	EvalCase,
	GateRule,
	GradeResult,
	HumanReviewRecord,
	RunManifest,
	ScoringPlan,
	TrialContext,
	TrialRecord,
} from "../../evals/harness/schema.js";
import {
	assessTrial,
	evaluateSummary,
	gradeTrial,
	modelResultFields,
	resultOutcome,
	summarize,
	terminalModelFailure,
} from "../../evals/harness/scoring.js";
import { containsCredential, credentialMatches, fallbackCostUsd } from "../../evals/harness/util.js";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temp(): string {
	const path = mkdtempSync(join(tmpdir(), "pipiclaw-eval-test-"));
	temporary.push(path);
	return path;
}

const passingGrade: GradeResult = {
	schemaVersion: 1,
	graderId: "g",
	graderVersion: "1",
	status: "pass",
	severity: "quality",
	evidence: [],
	rationale: "ok",
};

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
	return {
		id: "T-test-01",
		suite: "regression",
		source: "test",
		description: "test case",
		definitionFile: "evals/cases/test.ts",
		script: [{ kind: "user", text: "hello" }],
		graders: [{ graderId: "g", graderVersion: "1", grade: () => passingGrade }],
		...overrides,
	};
}

function record(outcome: TrialRecord["outcome"], caseId = "T-test-01"): TrialRecord {
	return {
		schemaVersion: 3,
		runId: "run",
		caseId,
		caseHash: "hash",
		trial: 1,
		observedModel: "provider/model",
		outcome,
		grades: [],
		metrics: {
			costUsd: 0.01,
			costBasis: "provider",
			tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			wallMs: 100,
			turns: 1,
			toolCalls: 0,
			segments: 1,
			duplicateExternalEffects: 0,
			userEscalations: 0,
		},
		startedAt: "2026-01-01T00:00:00.000Z",
	};
}

const manifest: RunManifest = {
	schemaVersion: 1,
	runId: "run",
	startedAt: "2026-01-01T00:00:00.000Z",
	gitSha: "sha",
	packageVersion: "1.0.0",
	lockfileHash: "lock",
	harnessSchemaVersions: {},
	configuredModel: "provider/model",
	settingsHash: "settings",
	toolsConfigHash: "tools",
	securityConfigHash: "security",
};

describe("behavior eval registry and reproducibility", () => {
	it("accepts the shipped catalog and rejects duplicate ids and malformed mid-turn crash scripts", () => {
		expect(() => validateCases(allCases)).not.toThrow();
		expect(() => validateCases([evalCase(), evalCase()])).toThrow(/Duplicate/);
		expect(() =>
			validateCases([evalCase({ script: [{ kind: "restart" }, { kind: "crash", mode: "midTurn" }] })]),
		).toThrow(/midTurn crash/);
	});

	it("tracks fixtures and conservatively fingerprints closure-backed case modules", () => {
		const root = temp();
		mkdirSync(join(root, "evals/cases"), { recursive: true });
		mkdirSync(join(root, "evals/fixtures"), { recursive: true });
		writeFileSync(join(root, "evals/cases/test.ts"), "source-a");
		writeFileSync(join(root, "evals/fixtures/data.txt"), "fixture-a");
		const item = evalCase({ fixtures: ["data.txt"] });
		const first = caseHash(item, root);

		// A declared fixture is part of the definition.
		writeFileSync(join(root, "evals/fixtures/data.txt"), "fixture-b");
		const fixtureChanged = caseHash(item, root);
		expect(fixtureChanged).not.toBe(first);

		// Legacy closures have undeclared captured constants. Until fixture migration, any
		// module edit conservatively invalidates its cases rather than silently comparing them.
		writeFileSync(join(root, "evals/cases/test.ts"), "source-b-with-an-unrelated-sibling-case");
		expect(caseHash(item, root)).not.toBe(fixtureChanged);

		// This case's own steps and grader implementation are.
		expect(caseHash(evalCase({ fixtures: ["data.txt"], script: [{ kind: "user", text: "other" }] }), root)).not.toBe(
			fixtureChanged,
		);
		expect(
			caseHash(
				evalCase({
					fixtures: ["data.txt"],
					graders: [{ graderId: "g", graderVersion: "1", grade: () => ({ ...passingGrade, status: "fail" }) }],
				}),
				root,
			),
		).not.toBe(fixtureChanged);
	});
});

const trialContext = (overrides: Partial<TrialContext> = {}): TrialContext => ({
	homeDir: "/tmp/eval",
	workspaceDir: "/tmp/eval/workspace",
	channelDir: "/tmp/eval/workspace/dm_eval",
	deliveries: [],
	trace: [],
	snapshot: { schemaVersion: 1, deliveries: [], fileTree: [], canaries: [], externalRequests: [] },
	...overrides,
});

describe("behavior eval multi-turn graders", () => {
	it("matches the final answer instead of accepting an earlier echo", async () => {
		const grader = lastDeliveryMatches("final", /^TARGET$/);
		const context = trialContext({
			deliveries: [
				{ method: "sendPlain", channelId: "dm_eval", text: "TARGET", ts: 1 },
				{ method: "sendPlain", channelId: "dm_eval", text: "wrong", ts: 2 },
			],
		});
		await expect(Promise.resolve(grader.grade(context))).resolves.toMatchObject({ status: "fail" });
	});

	it("detects a user-visible delivery emitted by a runtime-only maintenance step", async () => {
		const grader = noDeliveriesAfterStep("silent", "runMemoryMaintenance");
		const context = trialContext({
			trace: [
				{
					schemaVersion: 1,
					seq: 1,
					ts: "2026-01-01T00:00:00.000Z",
					segment: 1,
					kind: "step",
					fields: { kind: "runMemoryMaintenance" },
				},
			],
			deliveries: [{ method: "sendPlain", channelId: "dm_eval", text: "unexpected", ts: 1_767_225_600_001 }],
		});
		await expect(Promise.resolve(grader.grade(context))).resolves.toMatchObject({ status: "fail" });
	});

	/** A "step"/kind:"user" trace event plus one reply delivered right after it, for `recallQuiz`. */
	const questionTurn = (
		seq: number,
		ts: string,
		replyText: string,
	): { step: TrialContext["trace"][number]; delivery: TrialContext["deliveries"][number] } => ({
		step: { schemaVersion: 1, seq, ts, segment: 1, kind: "step", fields: { kind: "user" } },
		delivery: { method: "sendPlain", channelId: "dm_eval", text: replyText, ts: Date.parse(ts) + 500 },
	});

	it("scores recall and precision separately, and does not punish an honest miss like a wrong answer", async () => {
		const turns = [
			questionTurn(1, "2026-01-01T00:00:00.000Z", "CODE-A"),
			questionTurn(2, "2026-01-01T00:01:00.000Z", "I don't know, no record of that."),
		];
		const grader = recallQuiz(
			"quiz",
			[
				{ expected: /CODE-A/, distractor: /OLD-A/ },
				{ expected: /CODE-B/, distractor: /OLD-B/ },
			],
			{ minRecall: 0.5, minPrecision: 0.9 },
		);
		const context = trialContext({
			trace: turns.map((turn) => turn.step),
			deliveries: turns.map((turn) => turn.delivery),
		});
		const grade = await Promise.resolve(grader.grade(context));
		expect(grade.status).toBe("pass");
		expect(grade.score).toBeCloseTo(0.5);
		expect(grade.rationale).toMatch(/abstain=1/);
	});

	it("fails precision when a miss confidently answers with the superseded distractor value", async () => {
		const turns = [
			questionTurn(1, "2026-01-01T00:00:00.000Z", "CODE-A"),
			questionTurn(2, "2026-01-01T00:01:00.000Z", "OLD-B"),
		];
		const grader = recallQuiz("quiz", [
			{ expected: /CODE-A/, distractor: /OLD-A/ },
			{ expected: /CODE-B/, distractor: /OLD-B/ },
		]);
		const context = trialContext({
			trace: turns.map((turn) => turn.step),
			deliveries: turns.map((turn) => turn.delivery),
		});
		const grade = await Promise.resolve(grader.grade(context));
		expect(grade.status).toBe("fail");
		expect(grade.rationale).toMatch(/distractor/);
	});

	it("errors instead of silently mis-scoring when the script has fewer question turns than expected", async () => {
		const grader = recallQuiz("quiz", [
			{ expected: /A/, distractor: /B/ },
			{ expected: /C/, distractor: /D/ },
		]);
		const [turn] = [questionTurn(1, "2026-01-01T00:00:00.000Z", "A")];
		const context = trialContext({ trace: [turn!.step], deliveries: [turn!.delivery] });
		await expect(Promise.resolve(grader.grade(context))).resolves.toMatchObject({ status: "error" });
	});

	it("seeds a durable channel memory the same way memory_save/the reflect pass write one", async () => {
		const root = temp();
		const channelDir = join(root, "workspace", "dm_eval");
		await seedChannelMemory(
			{
				homeDir: root,
				workspaceDir: join(root, "workspace"),
				channelDir,
				canaryPath: join(root, "canary"),
				externalBaseUrl: "",
			},
			"Durable preference: cobalt.",
			{ name: "durable-preference-cobalt", type: "user" },
		);
		expect(readFileSync(join(channelDir, "memory", "durable-preference-cobalt.md"), "utf8")).toMatch(
			/description: Durable preference: cobalt\.[\s\S]*type: user[\s\S]*source: user/,
		);
		expect(readFileSync(join(channelDir, "MEMORY.md"), "utf8")).toContain("Durable preference: cobalt.");
	});
});

describe("behavior eval process and gate semantics", () => {
	it("splits restart and crash into independent worker segments", () => {
		const segments = segmentScript(
			evalCase({
				script: [
					{ kind: "user", text: "one" },
					{ kind: "restart" },
					{ kind: "user", text: "two" },
					{ kind: "crash", mode: "atStepBoundary" },
					{ kind: "user", text: "three" },
				],
			}),
		);
		expect(segments.map(({ start, end, mode }) => ({ start, end, mode }))).toEqual([
			{ start: 0, end: 1, mode: "graceful" },
			{ start: 2, end: 3, mode: "crash-boundary" },
			{ start: 4, end: 5, mode: "graceful" },
		]);
	});

	// F1/F2: neither easy samples nor tolerated quality failures may hide an exhausted
	// required case or an observed hard violation. Run and promotion share the same decision.
	it("counts resource exhaustion as failure and applies per-case sample minima", () => {
		const gate = { "T-test-01": { gate: "required" as const, minPass: "2/3" } };
		const items = [evalCase(), evalCase({ id: "T-other-01", trials: 6 })];
		const plan: ScoringPlan = {
			schemaVersion: 1,
			gates: gate,
			plannedTrials: { "T-test-01": 3, "T-other-01": 6 },
			maxInvalidShare: 0.1,
		};
		for (const outcomes of [
			["pass", "budget-exceeded", "budget-exceeded"],
			["pass", "pass", "budget-exceeded"],
		] as const) {
			const records = [
				...outcomes.map((outcome) => record(outcome)),
				...Array.from({ length: 6 }, () => record("pass", "T-other-01")),
			];
			const cases = summarize(records, items, gate, plan.plannedTrials);
			expect(cases[0]).toMatchObject({ valid: 3, invalid: 0 });
			const decision = evaluateSummary(cases, plan);
			expect(decision.code).toBe(outcomes[1] === "pass" ? 0 : 1);
			if (decision.code) expect(() => assertPromotableSummary({ schemaVersion: 2, cases }, plan)).toThrow();
			else expect(() => assertPromotableSummary({ schemaVersion: 2, cases }, plan)).not.toThrow();
		}
		const short = summarize([record("pass")], [evalCase()], gate, { "T-test-01": 1 });
		expect(evaluateSummary(short, { ...plan, plannedTrials: { "T-test-01": 1 } }).code).toBe(2);
		expect(evaluateSummary([], plan).code).toBe(2);
	});

	it("keeps v4 budget failures scorable and unknown invariant evidence inconclusive", () => {
		const gates = { "T-test-01": { gate: "required" as const, minPass: "2/3" } };
		const plan: ScoringPlan = { schemaVersion: 1, gates, plannedTrials: { "T-test-01": 3 }, maxInvalidShare: 0.1 };
		const stopped: TrialRecord = {
			...record("budget-exceeded"),
			schemaVersion: 4,
			result: assessTrial([passingGrade], "agent-limit", false),
		};
		const cases = summarize([record("pass"), stopped, stopped], [evalCase()], gates);
		expect(cases[0]).toMatchObject({ valid: 3, budgetExceeded: 2, invariantUnknown: 2 });
		expect(evaluateSummary(cases, plan).code).toBe(1);
		expect(
			evaluateSummary(summarize([record("pass"), record("pass"), stopped], [evalCase()], gates), plan).code,
		).toBe(2);
		const unavailable = summarize([record("pass"), record("invalid"), record("invalid")], [evalCase()], gates);
		expect(evaluateSummary(unavailable, plan).code).toBe(2);
		expect(() => assertPromotableSummary({ schemaVersion: 2, cases: unavailable }, plan)).toThrow();
		expect(() => assertPromotableSummary({ schemaVersion: 1, cases }, plan)).toThrow(/Legacy/);
	});

	it("keeps unavailable samples and their resource usage visible", () => {
		const unavailable = record("invalid");
		unavailable.metrics.costUsd = 4;
		unavailable.metrics.wallMs = 900;
		const summaries = summarize([record("pass"), unavailable], [evalCase()], {}, { "T-test-01": 2 });
		expect(summaries[0]).toMatchObject({ valid: 1, unknown: 1, started: 2, medianCostUsd: 2.005, medianWallMs: 500 });
		expect(
			evaluateSummary(summaries, {
				schemaVersion: 1,
				gates: {},
				plannedTrials: { "T-test-01": 2 },
				maxInvalidShare: 0.1,
			}).code,
		).toBe(2);
	});

	it("never averages away violations, even for quarantine or judge errors", () => {
		for (const gate of ["required", "report-only", "quarantine"] as const) {
			const gates: Record<string, GateRule> = { "T-test-01": { gate, minPass: "2/3" } };
			const violated = record("invalid");
			violated.grades = [
				{ ...passingGrade, status: "fail", severity: "hard-invariant" },
				{ ...passingGrade, status: "error" },
			];
			const cases = summarize([record("pass"), record("pass"), violated], [evalCase()], gates);
			const plan: ScoringPlan = { schemaVersion: 1, gates, plannedTrials: { "T-test-01": 3 }, maxInvalidShare: 0.1 };
			expect(evaluateSummary(cases, plan).code).toBe(1);
			expect(() => assertPromotableSummary({ schemaVersion: 2, cases }, plan)).toThrow(/invariant/);
		}
	});

	// Mutation checked 2026-09-10: removing invariant execution makes this test fail.
	it("runs invariant oracles on interrupted trials and preserves exceptions as unknown", async () => {
		const item = evalCase({
			invariants: [
				{ graderId: "boundary", graderVersion: "1", grade: () => ({ ...passingGrade, status: "fail" }) },
				{
					graderId: "missing-evidence",
					graderVersion: "1",
					grade: () => {
						throw new Error("missing checkpoint");
					},
				},
			],
			graders: [{ kind: "model", graderId: "judge", graderVersion: "1", rubric: "test", artifacts: () => "test" }],
		});
		for (const execution of ["completed", "agent-limit", "provider-error", "harness-error"] as const) {
			const grades = await gradeTrial(item, trialContext({}), execution, async () => ({
				...passingGrade,
				status: "error",
			}));
			expect(grades[0]).toMatchObject({ status: "fail", severity: "hard-invariant" });
			expect(grades[1]).toMatchObject({ status: "error", severity: "hard-invariant" });
			const result = assessTrial(grades, execution, execution === "completed");
			expect(result).toMatchObject({ execution, invariants: "violated", grading: "partial" });
			expect(resultOutcome(result)).toBe("invariant-violation");
		}
		expect(assessTrial([passingGrade], "agent-limit", false)).toMatchObject({
			acceptance: "fail",
			invariants: "unknown",
		});
		expect(
			assessTrial(
				[
					{ ...passingGrade, status: "fail" },
					{ ...passingGrade, status: "error" },
				],
				"completed",
				true,
			).acceptance,
		).toBe("fail");
	});

	it("does not accept an empty or skipped acceptance oracle", () => {
		for (const grades of [[], [{ ...passingGrade, status: "skipped" as const }]]) {
			expect(resultOutcome(assessTrial(grades, "completed", true))).toBe("invalid");
		}
	});

	// F3/F4: user-facing words and zero dispatch must not override explicit case contracts.
	it("grades an HTTP 429 explanation and a legitimate zero-dispatch case normally", async () => {
		const context = trialContext({
			deliveries: [
				{
					method: "sendPlain",
					channelId: "dm_eval",
					text: "HTTP 429 means rate limit; capacity may be exhausted.",
					ts: 1,
				},
			],
		});
		const item = evalCase({ script: [{ kind: "runTaskDriver" }] });
		const grades = await gradeTrial(item, context, "completed", async () => passingGrade);
		expect(resultOutcome(assessTrial(grades, "completed", true))).toBe("pass");
		expect(grades).toHaveLength(1);
		expect(
			modelResultFields({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: "429" } }),
		).toEqual({ stopReason: "stop" });
		expect(
			modelResultFields({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "429" },
			}),
		).toEqual({ stopReason: "error" });
		expect(
			modelResultFields({ type: "message_end", message: { role: "toolResult", content: "429" } }),
		).toBeUndefined();
	});

	it("requires explicit dispatch evidence only in cases whose contract needs work", async () => {
		for (const id of ["T-crash-01", "T-chain-recover-01", "TL-ticket-01", "TL-note-01", "TL-budget-01"]) {
			const item = allCases.find((item) => item.id === id)!;
			const grader = item.graders.find((grader) => grader.graderId.includes("dispatch"))!;
			if (grader.kind === "model") throw new Error("Expected a code oracle");
			expect(
				(
					await grader.grade(
						trialContext({
							deliveries: [{ method: "sendPlain", channelId: "dm_eval", text: "Done successfully", ts: 0 }],
						}),
					)
				).status,
			).toBe("fail");
			const trace: TrialContext["trace"] = [
				{
					schemaVersion: 1,
					seq: 1,
					segment: 1,
					ts: "2026-01-01T00:00:00Z",
					kind: "step",
					fields: { driverDispatch: "true" },
					ok: true,
				},
			];
			expect((await grader.grade(trialContext({ trace }))).status).toBe("pass");
			trace[0]!.ok = false;
			expect((await grader.grade(trialContext({ trace }))).status).toBe("fail");
		}
	});

	it("retains failed earlier steps while allowing a successful in-step model retry", () => {
		const event = (seq: number, stopReason: string): TrialContext["trace"][number] => ({
			schemaVersion: 1,
			seq,
			segment: 1,
			ts: "2026-01-01T00:00:00Z",
			kind: "model-result",
			fields: { stopReason },
		});
		expect(terminalModelFailure([event(1, "error"), event(2, "stop")])).toBeUndefined();
		const failed = event(1, "error");
		expect(terminalModelFailure([failed, { ...event(2, ""), kind: "step" }, event(3, "stop")])).toEqual(failed);
	});

	it("classifies all four budget limits without conflating them with invalid trials", () => {
		const budget = { maxCostUsd: 0.5, maxWallMs: 100, maxTurns: 2, maxSteps: 3 };
		expect(exceededBudgetReason(budget, { costUsd: 0, turns: 0 }, 0, 101, 100)).toBe("wall");
		expect(exceededBudgetReason(budget, { costUsd: 0.51, turns: 0 }, 0, 0, 100)).toBe("cost");
		expect(exceededBudgetReason(budget, { costUsd: 0, turns: 3 }, 0, 0, 100)).toBe("turns");
		expect(exceededBudgetReason(budget, { costUsd: 0, turns: 0 }, 4, 0, 100)).toBe("steps");
	});

	it("hard-stops a worker that ignores SIGTERM and isolates child homes", async () => {
		const root = temp();
		const worker = join(root, "probe.mjs");
		writeFileSync(
			worker,
			`import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.PIPICLAW_HOME;
mkdirSync(join(home, "state", "usage"), { recursive: true });
writeFileSync(join(home, "state", "usage", "probe"), home);
if (process.env.PROBE_HANG === "1") {
  process.on("SIGTERM", () => {});
  spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "inherit" });
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(JSON.stringify({ protocol: 1, type: "complete", observedModel: "probe" }) + "\\n");
  if (process.env.PROBE_COMPLETE_CHILD === "1") spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
}
`,
		);
		const item = evalCase();
		const common = {
			item,
			segment: { start: 0, end: 1, mode: "graceful" as const, delayMs: 0 },
			segmentNumber: 1,
			externalBaseUrl: "",
			trace: [],
			deliveries: [],
			usage: { costUsd: 0, turns: 0 },
			workerPath: worker,
		};
		const firstHome = join(root, "home-a");
		const secondHome = join(root, "home-b");
		mkdirSync(firstHome);
		mkdirSync(secondHome);
		await expect(
			runWorkerSegment({ ...common, homeDir: firstHome, deadlineMs: Date.now() + 10_000 }),
		).resolves.toMatchObject({ kind: "complete", observedModel: "probe" });
		await expect(
			runWorkerSegment({ ...common, homeDir: secondHome, deadlineMs: Date.now() + 10_000 }),
		).resolves.toMatchObject({ kind: "complete", observedModel: "probe" });
		expect(readFileSync(join(firstHome, "state/usage/probe"), "utf8")).toBe(firstHome);
		expect(readFileSync(join(secondHome, "state/usage/probe"), "utf8")).toBe(secondHome);

		const previousCompleteChild = process.env.PROBE_COMPLETE_CHILD;
		process.env.PROBE_COMPLETE_CHILD = "1";
		const completedWithChildAt = Date.now();
		try {
			await expect(
				runWorkerSegment({ ...common, homeDir: firstHome, deadlineMs: Date.now() + 10_000 }),
			).resolves.toMatchObject({ kind: "complete", observedModel: "probe" });
		} finally {
			if (previousCompleteChild === undefined) delete process.env.PROBE_COMPLETE_CHILD;
			else process.env.PROBE_COMPLETE_CHILD = previousCompleteChild;
		}
		expect(Date.now() - completedWithChildAt).toBeLessThan(3_500);

		const previous = process.env.PROBE_HANG;
		process.env.PROBE_HANG = "1";
		const started = Date.now();
		try {
			await expect(
				runWorkerSegment({ ...common, homeDir: firstHome, deadlineMs: Date.now() + 500 }),
			).resolves.toMatchObject({ kind: "budget", error: expect.stringContaining("wall") });
		} finally {
			if (previous === undefined) delete process.env.PROBE_HANG;
			else process.env.PROBE_HANG = previous;
		}
		expect(Date.now() - started).toBeLessThan(3_500);
	}, 10_000);
});

describe("behavior eval artifacts", () => {
	it("hashes untracked contents, not only their file names", () => {
		const root = temp();
		const { status } = spawnSync("git", ["init"], { cwd: root });
		expect(status).toBe(0);
		writeFileSync(join(root, "new-file.txt"), "first");
		const first = gitDirtyFingerprint(root);
		writeFileSync(join(root, "new-file.txt"), "second");
		expect(gitDirtyFingerprint(root)).not.toBe(first);
	});

	it("archives reviewable text evidence before the trial home is deleted", () => {
		const root = temp();
		const channel = join(root, "channel");
		mkdirSync(join(channel, "tasks"), { recursive: true });
		writeFileSync(join(channel, "MEMORY.md"), "- durable fact\n");
		writeFileSync(join(channel, "tasks", "t.md"), "---\nstatus: active\n---\n");
		writeFileSync(join(channel, "log.jsonl"), "cold storage excluded\n");
		writeFileSync(join(channel, "tasks", "t.jsonl"), '{"outcome":"continue"}\n');
		writeFileSync(join(channel, "big.md"), "x".repeat(9 * 1024 * 1024));
		const target = join(root, "archive");
		const index = captureArtifacts({ homeDir: root, workspaceDir: channel, channelDir: channel }, target);
		expect(index.entries.filter((entry) => entry.status === "complete")).toHaveLength(3);
		expect(readFileSync(join(target, "artifacts/workspace/MEMORY.md"), "utf8")).toBe("- durable fact\n");
		expect(readFileSync(join(target, "artifacts/workspace/tasks/t.jsonl"), "utf8")).toContain("continue");
		expect(index.complete).toBe(false);
		expect(() => verifyArtifacts(target)).toThrow(/incomplete/);
	});

	it("re-renders an archived report so late human-review verdicts reach calibration", () => {
		const root = temp();
		const dir = join(root, "evals/results/run-1");
		mkdirSync(dir, { recursive: true });
		const judged = record("pass");
		judged.grades = [{ ...passingGrade, graderId: "judge", graderKind: "model" }];
		writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
		writeFileSync(
			join(dir, "summary.json"),
			JSON.stringify({
				schemaVersion: 1,
				cases: [
					{
						caseId: judged.caseId,
						suite: "regression",
						gate: "report-only",
						passed: 1,
						valid: 1,
						invalid: 0,
						budgetExceeded: 0,
						medianCostUsd: 0,
						medianWallMs: 1,
						medianToolCalls: 0,
					},
				],
			}),
		);
		writeFileSync(join(dir, "trials.jsonl"), `${JSON.stringify(judged)}\n`);
		writeFileSync(join(dir, "report.md"), "# stale\n");
		// The run's own report is written before any verdict can exist, so without this command
		// model-grader calibration stays "pending" forever and nobody can promote a model grader.
		expect(rerenderReport(root, "run-1").reviews).toBe(0);
		expect(readFileSync(join(dir, "report.md"), "utf8")).toMatch(/calibration: pending/);
		writeFileSync(
			join(dir, "human-review.jsonl"),
			`${JSON.stringify({
				schemaVersion: 1,
				caseId: judged.caseId,
				trial: judged.trial,
				graderId: "judge",
				verdict: "agree",
				note: "checked",
				reviewer: "human",
				ts: "2026-01-01T00:00:00.000Z",
			})}\n`,
		);
		expect(rerenderReport(root, "run-1").reviews).toBe(1);
		expect(readFileSync(join(dir, "report.md"), "utf8")).toMatch(/calibration: 1\/1 \(100%\)/);
	});

	it("prices token usage when the provider omits amounts, and labels the basis", () => {
		expect(fallbackCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(3);
		expect(fallbackCostUsd({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(15);
		expect(fallbackCostUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
		// A zero-cost run must never read as free; the report has to say where the number came from.
		const priced = record("pass");
		priced.metrics.costBasis = "fallback";
		expect(renderReport({ ...manifest, costBasis: "fallback" }, [], [priced])).toMatch(
			/rate card[\s\S]*not an invoice/,
		);
		expect(renderReport({ ...manifest, costBasis: "provider" }, [], [priced])).toMatch(/provider-reported/);
	});

	it("finds credential material but deliberately skips auth.json", () => {
		const root = temp();
		writeFileSync(join(root, "auth.json"), '{"key":"sk-THIS_IS_IGNORED_123"}');
		writeFileSync(join(root, "trace.jsonl"), "api_key=abcdefghijklmnop");
		expect(containsCredential(root)).toBe(true);
		expect(credentialMatches(root)).toEqual(["trace.jsonl"]);
	});

	it("promotes sealed trial evidence under frozen gates and rejects forged summaries or changed artifacts", () => {
		const root = temp();
		const source = join(root, "evals/results/run-1");
		const trialDir = join(source, "trials/T-test-01-1");
		mkdirSync(trialDir, { recursive: true });
		writeFileSync(join(root, "evals/gates.json"), "{}\n");
		const scoring: ScoringPlan = {
			schemaVersion: 1,
			gates: { "T-test-01": { gate: "required" } },
			plannedTrials: { "T-test-01": 1 },
			maxInvalidShare: 0.1,
		};
		const item = { id: "T-test-01", suite: "regression" as const, caseHash: "hash" };
		const trial: TrialRecord = {
			...record("pass"),
			schemaVersion: 5,
			runId: "run-1",
			archiveComplete: true,
			grades: [passingGrade],
			result: assessTrial([{ ...passingGrade, graderKind: "code" }], "completed", true),
		};
		const summaries = summarize([trial], [item], scoring.gates, scoring.plannedTrials);
		for (const file of ["manifest.json", "cases.json"]) writeFileSync(join(source, file), "{}\n");
		writeFileSync(join(source, "plan.json"), JSON.stringify({ schemaVersion: 1, scoring, cases: [item] }));
		writeFileSync(join(source, "scoring-plan.json"), JSON.stringify(scoring));
		writeFileSync(join(source, "summary.json"), JSON.stringify({ schemaVersion: 2, cases: summaries }));
		writeFileSync(join(source, "report.md"), "report\n");
		writeFileSync(join(source, "trials.jsonl"), `${JSON.stringify(trial)}\n`);
		const homeDir = temp();
		const index = captureArtifacts({ homeDir, workspaceDir: homeDir, channelDir: homeDir }, trialDir);
		for (const file of ["trace.jsonl", "outcome.json", "grades.json", "agent-usage.json"])
			writeFileSync(join(trialDir, file), "{}\n");
		writeFileSync(join(trialDir, "record.json"), JSON.stringify(trial));
		sealArtifactIndex(trialDir, index, [
			"record.json",
			"trace.jsonl",
			"outcome.json",
			"grades.json",
			"agent-usage.json",
		]);
		// A claimed pass with a forged denominator must not establish a baseline.
		writeFileSync(
			join(source, "summary.json"),
			JSON.stringify({ schemaVersion: 2, cases: [{ ...summaries[0], medianWallMs: 999 }] }),
		);
		expect(() => promoteRun(root, "run-1")).toThrow(/differs from trial evidence/);
		writeFileSync(join(source, "summary.json"), JSON.stringify({ schemaVersion: 2, cases: summaries }));
		writeFileSync(join(trialDir, "outcome.json"), "changed");
		expect(() => promoteRun(root, "run-1")).toThrow(/missing or changed/);
		writeFileSync(join(trialDir, "outcome.json"), "{}\n");
		// Editing current gates cannot change the frozen run's promotion decision.
		writeFileSync(join(root, "evals/gates.json"), '{"new-required":{"gate":"required"}}');
		const before = readFileSync(join(root, "evals/gates.json"), "utf8");
		const target = promoteRun(root, "run-1");
		expect(readFileSync(join(root, "evals/gates.json"), "utf8")).toBe(before);
		expect(readFileSync(join(target, "trials.jsonl"), "utf8")).toBe(
			readFileSync(join(source, "trials.jsonl"), "utf8"),
		);
		expect(verifyArtifacts(join(target, "trials/T-test-01-1")).complete).toBe(true);
		expect(() => promoteRun(root, "run-1")).toThrow(/immutable/);
	});

	it("renders quarantine, invariant failures, condition comparability, and deltas", () => {
		const summary: CaseSummary = {
			caseId: "T-test-01",
			suite: "safety",
			gate: "quarantine",
			passed: 0,
			valid: 1,
			invalid: 0,
			budgetExceeded: 0,
			medianCostUsd: 0.1,
			medianWallMs: 1000,
			medianToolCalls: 1,
		};
		const failed = record("invariant-violation");
		failed.grades = [{ ...passingGrade, status: "fail", severity: "hard-invariant", rationale: "boundary crossed" }];
		const report = renderReport(manifest, [summary], [failed]);
		expect(report).toMatch(/Quarantine[\s\S]*boundary crossed/);
		expect(report).toMatch(/## Failures[\s\S]*T-test-01#1 \(invariant-violation\)[\s\S]*boundary crossed/);
		expect(report).toMatch(/Discrimination: 0\/1 cases passed every valid trial/);
		expect(
			renderDiff("a", "b", manifest, { ...manifest, gitSha: "other" }, [summary], [{ ...summary, passed: 1 }]),
		).not.toContain("+100pp");
	});

	it("reports observed model attribution and human model-grader calibration", () => {
		const judged = record("pass");
		judged.observedModel = "provider/observed";
		judged.grades = [{ ...passingGrade, graderId: "judge", score: 1 }];
		const review: HumanReviewRecord = {
			schemaVersion: 1,
			caseId: judged.caseId,
			trial: judged.trial,
			graderId: "judge",
			verdict: "agree",
			note: "calibration sample",
			reviewer: "test",
			ts: "2026-01-01T00:00:00.000Z",
		};
		expect(humanReviewCalibration([judged], [review])).toEqual({ reviewed: 1, agreed: 1, agreement: 1 });
		expect(renderReport(manifest, [], [judged], [review])).toMatch(
			/Observed model\(s\): provider\/observed[\s\S]*1\/1 \(100%\)/,
		);
	});
});
