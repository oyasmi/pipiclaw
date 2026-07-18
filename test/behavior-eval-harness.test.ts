import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { caseHash, validateCases } from "../evals/harness/cases.js";
import { renderDiff } from "../evals/harness/diff.js";
import { promoteRun } from "../evals/harness/promote.js";
import {
	evaluateExit,
	exceededBudgetReason,
	gitDirtyFingerprint,
	humanReviewCalibration,
	renderReport,
	runWorkerSegment,
	segmentScript,
} from "../evals/harness/run.js";
import type {
	CaseSummary,
	EvalCase,
	GradeResult,
	HumanReviewRecord,
	RunManifest,
	TrialRecord,
} from "../evals/harness/schema.js";
import { containsCredential, credentialMatches } from "../evals/harness/util.js";

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
		schemaVersion: 2,
		runId: "run",
		caseId,
		caseHash: "hash",
		trial: 1,
		observedModel: "provider/model",
		outcome,
		grades: [],
		metrics: {
			costUsd: 0.01,
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

	it("changes caseHash when source or a declared fixture changes", () => {
		const root = temp();
		mkdirSync(join(root, "evals/cases"), { recursive: true });
		mkdirSync(join(root, "evals/fixtures"), { recursive: true });
		writeFileSync(join(root, "evals/cases/test.ts"), "source-a");
		writeFileSync(join(root, "evals/fixtures/data.txt"), "fixture-a");
		const item = evalCase({ fixtures: ["data.txt"] });
		const first = caseHash(item, root);
		writeFileSync(join(root, "evals/fixtures/data.txt"), "fixture-b");
		const fixtureChanged = caseHash(item, root);
		writeFileSync(join(root, "evals/cases/test.ts"), "source-b");
		expect(fixtureChanged).not.toBe(first);
		expect(caseHash(item, root)).not.toBe(fixtureChanged);
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

	it("finds credential material but deliberately skips auth.json", () => {
		const root = temp();
		writeFileSync(join(root, "auth.json"), '{"key":"sk-THIS_IS_IGNORED_123"}');
		writeFileSync(join(root, "trace.jsonl"), "api_key=abcdefghijklmnop");
		expect(containsCredential(root)).toBe(true);
		expect(credentialMatches(root)).toEqual(["trace.jsonl"]);
	});

	it("promotes only frozen summaries and cannot modify gates.json", () => {
		const root = temp();
		const source = join(root, "evals/results/run-1");
		mkdirSync(source, { recursive: true });
		mkdirSync(join(root, "evals"), { recursive: true });
		writeFileSync(join(root, "evals/gates.json"), '{"T-test-01":{"gate":"required"}}\n');
		for (const file of ["manifest.json", "cases.json"]) writeFileSync(join(source, file), "{}\n");
		writeFileSync(
			join(source, "summary.json"),
			`${JSON.stringify({
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
			})}\n`,
		);
		writeFileSync(join(source, "report.md"), "report\n");
		writeFileSync(join(source, "trials.jsonl"), "secret trial data not promoted\n");
		const gatesBefore = readFileSync(join(root, "evals/gates.json"), "utf8");
		const target = promoteRun(root, "run-1");
		expect(readFileSync(join(root, "evals/gates.json"), "utf8")).toBe(gatesBefore);
		expect(() => readFileSync(join(target, "trials.jsonl"), "utf8")).toThrow();
	});

	it("refuses to promote a run that misses a required gate", () => {
		const root = temp();
		const source = join(root, "evals/results/run-1");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(root, "evals/gates.json"), '{"T-test-01":{"gate":"required"}}\n');
		writeFileSync(join(source, "manifest.json"), "{}\n");
		writeFileSync(join(source, "cases.json"), "{}\n");
		writeFileSync(join(source, "report.md"), "failed report\n");
		writeFileSync(
			join(source, "summary.json"),
			`${JSON.stringify({
				schemaVersion: 1,
				cases: [
					{
						caseId: "T-test-01",
						suite: "regression",
						gate: "required",
						passed: 0,
						valid: 1,
						invalid: 0,
						medianCostUsd: 0,
						medianWallMs: 1,
						medianToolCalls: 0,
					},
				],
			})}\n`,
		);
		expect(() => promoteRun(root, "run-1")).toThrow(/misses required gate/);
	});

	it("renders quarantine, invariant failures, condition comparability, and deltas", () => {
		const summary: CaseSummary = {
			caseId: "T-test-01",
			suite: "safety",
			gate: "quarantine",
			passed: 0,
			valid: 1,
			invalid: 0,
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
