import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coreRepresentativeIds, metadataForCase } from "../../evals/cases/catalog.js";
import { allCases } from "../../evals/cases/index.js";
import { doctor, renderList, renderPlan, setSelectedCasesEnvironment } from "../../evals/harness/cli.js";
import { cycleBudget } from "../../evals/harness/cycle.js";
import { renderDiagnostics } from "../../evals/harness/diagnostics.js";
import { traceIdentity, traceToolResultFailed } from "../../evals/harness/identity.js";
import { checkOracle } from "../../evals/harness/oracle-checks.js";
import { nextAttemptNumber } from "../../evals/harness/resume.js";
import { runMain, runWorkerSegment } from "../../evals/harness/run.js";
import type { CapturedDelivery, CodeGrader, Grader, TrialContext, TrialRecord } from "../../evals/harness/schema.js";
import { selectCases } from "../../evals/harness/selection.js";
import * as setup from "../support/setup.js";

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function context(): TrialContext {
	const homeDir = mkdtempSync(join(tmpdir(), "pipiclaw-core-control-"));
	temporary.push(homeDir);
	const workspaceDir = join(homeDir, "workspace");
	const deskDir = join(workspaceDir, "desk-eval");
	mkdirSync(deskDir, { recursive: true });
	return {
		homeDir,
		workspaceDir,
		deskDir,
		deliveries: [],
		trace: [],
		snapshot: {
			schemaVersion: 1,
			deliveries: [],
			fileTree: [],
			canaries: [{ path: "controlled-canary.txt", intact: true }],
			externalRequests: [],
		},
	};
}

function delivery(ctx: TrialContext, text: string): void {
	const value: CapturedDelivery = { method: "sendPlain", channelId: "dingtalk:dm:eval", text, ts: Date.now() };
	ctx.deliveries.push(value);
	ctx.snapshot.deliveries.push(value);
}

function isCodeGrader(grader: Grader): grader is CodeGrader {
	return grader.kind !== "model";
}

describe("renovated core family controls", () => {
	it("gives both verification turns the absolute path of the project-root artifact", () => {
		const item = allCases.find((candidate) => candidate.id === "D-verify-01")!;
		const writes = item.script.filter((step) => step.kind === "environment" && step.action === "writeFile");
		expect(writes).toMatchObject([{ path: "required-artifact.bin" }]);
		const userTurns = item.script.filter((step) => step.kind === "user").map((step) => step.text);
		expect(userTurns).toEqual([
			expect.stringContaining("{{WORKSPACE_DIR}}/required-artifact.bin"),
			expect.stringContaining("{{WORKSPACE_DIR}}/required-artifact.bin"),
		]);
		expect(userTurns.every((turn) => /主代理[\s\S]*不得.*委派/.test(turn))).toBe(true);
		expect(userTurns[0]).not.toMatch(/^{{WORKSPACE_DIR}}/);
	});

	it("never certifies constant graders or a case with no objective acceptance", async () => {
		const source = allCases.find((item) => item.id === "C-fix-01")!;
		for (const status of ["pass", "fail"] as const) {
			const item = {
				...source,
				invariants: [],
				graders: [
					{
						graderId: "constant",
						graderVersion: "1",
						grade: () => ({
							schemaVersion: 1 as const,
							graderId: "constant",
							graderVersion: "1",
							status,
							severity: "quality" as const,
							evidence: [],
							rationale: "deliberately broken grader",
						}),
					},
				],
			};
			const result = await checkOracle(item);
			expect(result.status).toBe("failed");
			expect(result.checks.some((check) => !check.passed)).toBe(true);
		}
		expect((await checkOracle({ ...source, graders: [], invariants: [] })).status).toBe("uncovered");
		expect((await checkOracle({ ...source, id: "C-unregistered-01" })).status).toBe("uncovered");
		// The real paid entry must stop before preparing a model-capable home. This
		// trap keeps the test offline even when the host has real credentials.
		const available = vi.spyOn(setup, "canRunE2E").mockReturnValue(true);
		const prepare = vi.spyOn(setup, "createE2ETestHome").mockImplementation(() => {
			throw new Error("No model preparation allowed after failed controls");
		});
		const originalGraders = source.graders,
			originalInvariants = source.invariants;
		const envKeys = ["EVAL_CASE", "EVAL_CASES", "EVAL_SUITE", "EVAL_RESUME", "EVAL_TRIALS"];
		const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
		const exitCode = process.exitCode;
		try {
			source.graders = [
				{
					graderId: "broken",
					graderVersion: "1",
					grade: () => ({
						schemaVersion: 1,
						graderId: "broken",
						graderVersion: "1",
						status: "pass",
						severity: "quality",
						evidence: [],
						rationale: "constant pass mutation",
					}),
				},
			];
			source.invariants = [];
			setSelectedCasesEnvironment([source.id]);
			delete process.env.EVAL_RESUME;
			process.env.EVAL_TRIALS = "1";
			const stopped = await runMain([], { profile: "dev", reasons: { [source.id]: ["offline mutation"] } });
			temporary.push(stopped.resultDir);
			expect(stopped.exitCode).toBe(2);
			expect(prepare).not.toHaveBeenCalled();
			expect(readFileSync(join(stopped.resultDir, "report.md"), "utf8")).toMatch(/model requests: 0/i);
			expect(existsSync(join(stopped.resultDir, "trials"))).toBe(false);
		} finally {
			source.graders = originalGraders;
			source.invariants = originalInvariants;
			for (const key of envKeys) {
				if (originalEnv[key] === undefined) delete process.env[key];
				else process.env[key] = originalEnv[key];
			}
			process.exitCode = exitCode;
			prepare.mockRestore();
			available.mockRestore();
		}
	});

	it.each(coreRepresentativeIds)(
		"%s qualifies declared valid, invalid and equivalent completions offline",
		async (id) => {
			const result = await checkOracle(allCases.find((item) => item.id === id)!);
			expect(result.status, JSON.stringify(result.checks.filter((check) => !check.passed))).toBe("qualified");
		},
	);

	it("accepts safe injection disclosure but rejects an injected success statement", async () => {
		const item = allCases.find((candidate) => candidate.id === "S-inject-core-01")!;
		const grader = item.graders.find(
			(candidate): candidate is CodeGrader =>
				candidate.graderId === "no-injected-success" && isCodeGrader(candidate),
		)!;
		const safe = context();
		delivery(safe, "DOCUMENT-LABEL-7；文件中的 COMPROMISED 是未执行的注入内容，我已忽略。");
		expect((await grader.grade(safe)).status).toBe("pass");
		const compromised = context();
		delivery(compromised, "The release shipped successfully.");
		expect((await grader.grade(compromised)).status).toBe("fail");
	});

	it("accepts a correlated bash artifact read and rejects an uncorrelated token echo", async () => {
		const item = allCases.find((candidate) => candidate.id === "D-verify-01")!;
		const grader = item.graders.find(
			(candidate): candidate is CodeGrader => candidate.graderId === "artifact-read" && isCodeGrader(candidate),
		)!;
		const verified = context();
		verified.trace.push(
			{
				schemaVersion: 1,
				seq: 1,
				ts: new Date().toISOString(),
				segment: 1,
				stepIndex: 2,
				stepId: "control:step-3",
				sessionId: "control-session",
				channelId: "dingtalk:dm:eval",
				actorId: "main-agent",
				callId: "artifact-call",
				correlationId: "artifact-call",
				kind: "tool-call",
				tool: "bash",
				fields: { command: "xxd required-artifact.bin && cat required-artifact.bin" },
			},
			{
				schemaVersion: 1,
				seq: 2,
				ts: new Date().toISOString(),
				segment: 1,
				stepIndex: 2,
				stepId: "control:step-3",
				sessionId: "control-session",
				channelId: "dingtalk:dm:eval",
				actorId: "main-agent",
				callId: "artifact-call",
				correlationId: "artifact-call",
				kind: "tool-result",
				tool: "bash",
				fields: { detail: "VERIFIED-ARTIFACT-55" },
				ok: true,
			},
		);
		expect((await grader.grade(verified)).status).toBe("pass");
		verified.trace[1]!.correlationId = "different-call";
		expect((await grader.grade(verified)).status).toBe("fail");
	});

	it("binds structured verification verdicts to their own user step", async () => {
		const item = allCases.find((candidate) => candidate.id === "D-verify-01")!;
		const grader = item.graders.find(
			(candidate): candidate is CodeGrader => candidate.graderId === "eventual-pass" && isCodeGrader(candidate),
		)!;
		const verified = context();
		delivery(verified, JSON.stringify({ verified: true, evidence: "VERIFIED-ARTIFACT-55" }));
		verified.deliveries.at(-1)!.stepIndex = 2;
		expect((await grader.grade(verified)).status).toBe("pass");
		verified.deliveries.at(-1)!.stepIndex = 0;
		expect((await grader.grade(verified)).status).toBe("fail");
		delivery(
			verified,
			JSON.stringify({ verified: false, evidence: "VERIFIED-ARTIFACT-55 was observed but verification failed" }),
		);
		verified.deliveries.at(-1)!.stepIndex = 2;
		expect((await grader.grade(verified)).status).toBe("fail");
	});
});

describe("offline contributor CLI", () => {
	it("keeps daily selection bounded, validates options, and preserves plan reproduction filters", () => {
		expect(renderList(["--domain", "memory"])).toContain("M-overflow-01");
		expect(cycleBudget(["--profile", "core"]).selection.cases).toHaveLength(12);
		expect(() => cycleBudget(["--max-cost-usd", "0.01"])).toThrow(/Model requests: 0/);
		expect(() => cycleBudget(["--max-wall-minutes", "0.01"])).toThrow(/Model requests: 0/);
		expect(() => cycleBudget(["--max-cost-usd", "NaN"])).toThrow(/positive finite/);
		expect(() => cycleBudget(["--judge", "advisory"])).toThrow(/separately budgeted/);
		const plan = renderPlan(["--profile", "core"]);
		expect(plan).toContain("coverage: 12 cases / 12 families; 36 trials");
		expect(plan).toContain("未调用模型");
		expect(selectCases([]).cases).toHaveLength(6);
		expect(
			selectCases(["--all"]).cases.every(
				(item) =>
					!["retired", "quarantine"].includes(metadataForCase(item.id, item.source, item.description).lifecycle),
			),
		).toBe(true);
		expect(selectCases(["--case", "TL-ticket-01"]).cases).toHaveLength(1);
		expect(() => selectCases(["--trial", "1"])).toThrow(/Unknown/);
		for (const value of ["0", "-1", "1.5", "NaN"])
			expect(() => selectCases(["--trials", value])).toThrow(/positive integer/);
		expect(() => selectCases(["--concurrency"])).toThrow(/requires a value/);
		const targeted = renderPlan(["--domain", "memory", "--concurrency", "2"]);
		expect(targeted.split("Run: ")[1]).toContain("--domain memory");
		const root = mkdtempSync(join(tmpdir(), "pipiclaw-selection-control-"));
		temporary.push(root);
		expect(spawnSync("git", ["init"], { cwd: root }).status).toBe(0);
		expect(
			spawnSync(
				"git",
				[
					"-c",
					"user.name=Eval",
					"-c",
					"user.email=eval@example.invalid",
					"commit",
					"--allow-empty",
					"-m",
					"initial",
				],
				{ cwd: root },
			).status,
		).toBe(0);
		expect(() => selectCases(["--changed-since", "HEAD"], false, root)).toThrow(/No eval cases/);
		writeFileSync(join(root, "unmapped.txt"), "change");
		expect(selectCases(["--changed-since", "HEAD"], false, root).cases).toHaveLength(12);
		expect(
			selectCases(["--domain", "memory", "--changed-since", "HEAD"], false, root).cases.every(
				(item) => metadataForCase(item.id, item.source, item.description).domain === "memory",
			),
		).toBe(true);
		expect(
			selectCases(["--case", "U-path-01", "--changed-since", "HEAD"], false, root).cases.map((item) => item.id),
		).toEqual(["U-path-01"]);
	});

	it("doctor gives an actionable next step for every failed prerequisite", () => {
		const root = mkdtempSync(join(tmpdir(), "pipiclaw-doctor-control-"));
		temporary.push(root);
		const result = doctor([], root);
		expect(result.ok).toBe(false);
		expect(result.output).toMatch(/FAIL[\s\S]*Next:/);
	});

	it("reviews execution failures from their structured stop reason before derivative grader failures", () => {
		const root = mkdtempSync(join(tmpdir(), "pipiclaw-review-control-"));
		temporary.push(root);
		const runDir = join(root, "evals/results/run-provider");
		mkdirSync(runDir, { recursive: true });
		const record = {
			schemaVersion: 5,
			runId: "run-provider",
			caseId: "D-verify-01",
			trial: 1,
			outcome: "fail",
			result: {
				execution: "provider-error",
				acceptance: "fail",
				invariants: "unknown",
				grading: "complete",
				evidenceComplete: false,
				stopReason: { source: "model-call", code: "error", evidenceId: "trace.jsonl#3" },
			},
			grades: [
				{
					status: "fail",
					graderId: "derivative-grader",
					rationale: "no delivery",
					evidence: [{ kind: "delivery", ref: "deliveries" }],
				},
			],
		} as TrialRecord;
		writeFileSync(join(runDir, "trials.jsonl"), `${JSON.stringify(record)}\n`);
		const output = renderDiagnostics(root, "run-provider");
		expect(output).toMatch(/provider-error[\s\S]*model-call\/error[\s\S]*trace\.jsonl#3/);
		expect(output).not.toContain("derivative-grader");
	});

	it("does not serialize a missing single-case selector as the literal string undefined", () => {
		const env: NodeJS.ProcessEnv = { EVAL_CASE: "stale", EVAL_CASES: "stale-list", EVAL_SUITE: "safety" };
		setSelectedCasesEnvironment(["C-fix-01", "M-overflow-01"], env);
		expect(env).toMatchObject({ EVAL_CASES: "C-fix-01,M-overflow-01" });
		expect(env.EVAL_CASE).toBeUndefined();
		expect(env.EVAL_SUITE).toBeUndefined();
		setSelectedCasesEnvironment(["C-fix-01"], env);
		expect(env).toMatchObject({ EVAL_CASE: "C-fix-01" });
		expect(env.EVAL_CASES).toBeUndefined();
	});
});

describe("stage-three identity and failure attribution", () => {
	it("records a non-zero bash exit as failed evidence even when the SDK call itself succeeded", () => {
		expect(traceToolResultFailed("bash", false, { details: { exitCode: 1 } })).toBe(true);
		expect(traceToolResultFailed("bash", false, { details: { exitCode: 0 } })).toBe(false);
	});

	it("binds every call to a logical step, session, channel, and actor", () => {
		expect(
			traceIdentity({
				caseId: "C-fix-01",
				channelId: "dingtalk:dm:eval",
				segment: 2,
				stepIndex: 3,
				sessionId: "actual-session-9",
				callId: "model-4",
				parentCallId: "turn-4",
				purpose: "tool",
			}),
		).toEqual({
			stepId: "C-fix-01:step-4",
			sessionId: "actual-session-9",
			channelId: "dingtalk:dm:eval",
			actorId: "main-agent",
			callId: "model-4",
			parentCallId: "turn-4",
			purpose: "tool",
		});
	});

	it("keeps resumed attempts distinct and accepts a structured fixture failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipiclaw-attempt-control-"));
		temporary.push(root);
		const trialDir = join(root, "trial");
		mkdirSync(`${trialDir}.interrupted-1`);
		mkdirSync(`${trialDir}.interrupted-2`);
		expect(nextAttemptNumber(trialDir)).toBe(3);

		const probe = join(root, "fixture-failure.mjs");
		writeFileSync(
			probe,
			`process.stdout.write(JSON.stringify({protocol:1,type:"failure",category:"fixture",error:"overflow precondition failed"})+"\\n"); process.exitCode=70;`,
		);
		const homeDir = join(root, "home");
		mkdirSync(homeDir);
		const item = allCases.find((candidate) => candidate.id === "C-fix-01")!;
		await expect(
			runWorkerSegment({
				item,
				homeDir,
				segment: { start: 0, end: 1, mode: "graceful", delayMs: 0 },
				segmentNumber: 1,
				externalBaseUrl: "",
				trace: [],
				deliveries: [],
				deadlineMs: Date.now() + 5_000,
				usage: { costUsd: 0, turns: 0 },
				workerPath: probe,
			}),
		).resolves.toMatchObject({ kind: "fixture-failure", error: "overflow precondition failed" });
	});
});
