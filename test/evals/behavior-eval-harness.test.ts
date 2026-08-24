import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedChannelHistory, seedChannelMemory } from "../../evals/cases/helpers.js";
import { caseHash, validateCases } from "../../evals/harness/cases.js";
import { renderDiff } from "../../evals/harness/diff.js";
import { lastDeliveryMatches, noDeliveriesAfterStep, recallQuiz } from "../../evals/harness/graders.js";
import { promoteRun } from "../../evals/harness/promote.js";
import { rerenderReport } from "../../evals/harness/report.js";
import {
	archiveEvidence,
	evaluateExit,
	exceededBudgetReason,
	gitDirtyFingerprint,
	humanReviewCalibration,
	renderReport,
	runWorkerSegment,
	segmentScript,
	summarize,
} from "../../evals/harness/run.js";
import type {
	CaseSummary,
	EvalCase,
	GradeResult,
	HumanReviewRecord,
	RunManifest,
	TrialContext,
	TrialRecord,
} from "../../evals/harness/schema.js";
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
	it("rejects duplicate ids and malformed mid-turn crash scripts", () => {
		expect(() => validateCases([evalCase(), evalCase()])).toThrow(/Duplicate/);
		expect(() =>
			validateCases([evalCase({ script: [{ kind: "restart" }, { kind: "crash", mode: "midTurn" }] })]),
		).toThrow(/midTurn crash/);
	});

	it("tracks a case's own definition and fixtures, not edits to unrelated siblings", () => {
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

		// Editing a sibling case in the same module must not re-hash this one, or every
		// cross-run comparison reports "the case definition changed" and the signal is useless.
		writeFileSync(join(root, "evals/cases/test.ts"), "source-b-with-an-unrelated-sibling-case");
		expect(caseHash(item, root)).toBe(fixtureChanged);

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

describe("behavior eval multi-turn graders", () => {
	const trialContext = (overrides: Partial<TrialContext> = {}): TrialContext => ({
		homeDir: "/tmp/eval",
		workspaceDir: "/tmp/eval/workspace",
		channelDir: "/tmp/eval/workspace/dm_eval",
		deliveries: [],
		trace: [],
		snapshot: { schemaVersion: 1, deliveries: [], fileTree: [], canaries: [], externalRequests: [] },
		...overrides,
	});

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

	it("seeds durable memory and history in parser-manageable shapes", async () => {
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
			"- Durable preference: cobalt.",
		);
		expect(readFileSync(join(channelDir, "MEMORY.md"), "utf8")).toMatch(
			/^# Channel Memory[\s\S]*^## Seeded Facts[\s\S]*^- Durable preference: cobalt\.$/m,
		);

		await seedChannelHistory(
			{
				homeDir: root,
				workspaceDir: join(root, "workspace"),
				channelDir,
				canaryPath: join(root, "canary"),
				externalBaseUrl: "",
			},
			"## Folded History Through 2026-01-01T00:00:00.000Z\n\n- Old value: cobalt.",
		);
		// A caller-controlled heading keeps a Folded History section a recall candidate.
		expect(readFileSync(join(channelDir, "HISTORY.md"), "utf8")).toMatch(
			/^# Channel History[\s\S]*^## Folded History Through 2026-01-01T00:00:00\.000Z[\s\S]*Old value: cobalt\.$/m,
		);
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

	it("excludes invalid trials, makes >10% invalid inconclusive, and ignores quarantine", () => {
		expect(evaluateExit([record("pass"), record("invalid")], {})).toBe(2);
		expect(evaluateExit([record("fail")], { "T-test-01": { gate: "quarantine" } })).toBe(0);
		expect(evaluateExit([record("fail")], { "T-test-01": { gate: "required", minPass: "2/3" } })).toBe(1);
		expect(evaluateExit([record("pass")], { "T-test-01": { gate: "required", minPass: "2/3" } })).toBe(0);
	});

	it("keeps budget-stopped trials out of the pass-rate denominator but still visible", () => {
		const gate = { "T-test-01": { gate: "required" as const, minPass: "2/3" } };
		// A provider stall is not an agent failure. Two passes and one wall-clock stop leave the
		// 2/3 gate satisfied on the trials that actually ran — the stop must never read as the
		// regression that a genuine `fail` would.
		const withStall = [
			record("pass"),
			record("pass"),
			record("budget-exceeded"),
			...Array.from({ length: 7 }, () => record("pass", "T-other-01")),
		];
		expect(evaluateExit(withStall, gate)).toBe(0);
		expect(evaluateExit([record("fail"), record("fail"), record("pass")], gate)).toBe(1);
		// A required case that only ever times out was never confirmed, so it cannot pass silently.
		expect(
			evaluateExit(
				[record("budget-exceeded"), ...Array.from({ length: 20 }, () => record("pass", "T-other-01"))],
				gate,
			),
		).toBe(1);
		// ...and a run drowning in stops measured latency, not behavior: inconclusive, not red.
		expect(evaluateExit([record("pass"), record("budget-exceeded"), record("budget-exceeded")], gate)).toBe(2);

		const [summary] = summarize(withStall, [evalCase()], gate);
		expect(summary).toMatchObject({ passed: 2, valid: 2, invalid: 0, budgetExceeded: 1 });
		expect(renderReport(manifest, [summary!], withStall)).toMatch(/Budget/);
	});

	it("fails a required gate whose every trial was invalid instead of passing on ceil(ratio * 0)", () => {
		const records = [...Array.from({ length: 9 }, () => record("pass", "T-ok-01")), record("invalid", "T-req-01")];
		expect(evaluateExit(records, { "T-req-01": { gate: "required", minPass: "2/3" } })).toBe(1);
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
		writeFileSync(join(channel, "log.jsonl"), "not a reviewable artifact\n");
		writeFileSync(join(channel, "big.md"), "x".repeat(70_000));
		const target = join(root, "archive");
		expect(archiveEvidence(channel, target)).toBe(2);
		expect(readFileSync(join(target, "MEMORY.md"), "utf8")).toBe("- durable fact\n");
		expect(readFileSync(join(target, "tasks/t.md"), "utf8")).toMatch(/status: active/);
		expect(() => readFileSync(join(target, "big.md"), "utf8")).toThrow();
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

	it("promotes only frozen summaries without touching gates.json, and refuses a run that misses a required gate", () => {
		const root = temp();
		const source = join(root, "evals/results/run-1");
		mkdirSync(source, { recursive: true });
		mkdirSync(join(root, "evals"), { recursive: true });
		writeFileSync(join(root, "evals/gates.json"), '{"T-test-01":{"gate":"required"}}\n');
		for (const file of ["manifest.json", "cases.json"]) writeFileSync(join(source, file), "{}\n");

		const passingSummary = `${JSON.stringify({
			schemaVersion: 1,
			cases: [
				{
					caseId: "T-test-01",
					suite: "regression",
					gate: "required",
					passed: 1,
					valid: 1,
					invalid: 0,
					medianCostUsd: 0,
					medianWallMs: 1,
					medianToolCalls: 0,
				},
			],
		})}\n`;
		writeFileSync(join(source, "summary.json"), passingSummary);
		writeFileSync(join(source, "report.md"), "report\n");
		writeFileSync(join(source, "trials.jsonl"), "secret trial data not promoted\n");
		const gatesBefore = readFileSync(join(root, "evals/gates.json"), "utf8");
		const target = promoteRun(root, "run-1");
		expect(readFileSync(join(root, "evals/gates.json"), "utf8")).toBe(gatesBefore);
		expect(() => readFileSync(join(target, "trials.jsonl"), "utf8")).toThrow();

		// The same run shape with passed: 0 must not promote at all (fresh root: the first
		// promotion created an immutable baseline under this one).
		const failingRoot = temp();
		const failingSource = join(failingRoot, "evals/results/run-1");
		mkdirSync(failingSource, { recursive: true });
		writeFileSync(join(failingRoot, "evals/gates.json"), '{"T-test-01":{"gate":"required"}}\n');
		writeFileSync(join(failingSource, "manifest.json"), "{}\n");
		writeFileSync(join(failingSource, "cases.json"), "{}\n");
		writeFileSync(join(failingSource, "report.md"), "failed report\n");
		writeFileSync(join(failingSource, "summary.json"), passingSummary.replace('"passed":1', '"passed":0'));
		expect(() => promoteRun(failingRoot, "run-1")).toThrow(/misses required gate/);
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
		).toMatch(/git[\s\S]*no[\s\S]*\+100pp/);
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
