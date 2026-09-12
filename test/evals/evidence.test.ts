import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicJson, captureArtifacts, sealArtifactIndex, verifyArtifacts } from "../../evals/harness/artifacts.js";
import { fileContains } from "../../evals/harness/graders.js";
import { runJudgeProcess } from "../../evals/harness/judge-process.js";
import { EvalPool } from "../../evals/harness/pool.js";
import { regradeTrial } from "../../evals/harness/regrade.js";
import { readResourceLedger, summarizeResources } from "../../evals/harness/resources.js";
import { completedTrial, preserveInterruptedAttempt } from "../../evals/harness/resume.js";
import { runWorkerSegment } from "../../evals/harness/run.js";
import type { CaseDescriptor, EvalCase, TrialRecord } from "../../evals/harness/schema.js";
import type { UsageLedgerEntry } from "../../src/usage/ledger.js";

const roots: string[] = [];
const temp = () => {
	const root = mkdtempSync(join(tmpdir(), "eval-evidence-"));
	roots.push(root);
	return root;
};
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const item: EvalCase = {
	id: "C-probe-01",
	suite: "regression",
	source: "test",
	description: "test",
	definitionFile: "evals/cases/regression.ts",
	script: [{ kind: "user", text: "fix it" }],
	graders: [
		fileContains("fixed", "result.txt", /fixed/),
		{
			kind: "code",
			graderId: "hidden-evaluator-restored",
			graderVersion: "1",
			grade: async (ctx) => ({
				schemaVersion: 1,
				graderId: "hidden-evaluator-restored",
				graderVersion: "1",
				graderKind: "code",
				status:
					readFileSync(join(ctx.homeDir, ".eval-hidden/evaluator.mjs"), "utf8") === "hidden\n" ? "pass" : "fail",
				severity: "quality",
				evidence: [{ kind: "file", ref: ".eval-hidden/evaluator.mjs" }],
				rationale: "hidden evaluator must be restored under the replay home",
			}),
		},
	],
};
const descriptor: CaseDescriptor = {
	schemaVersion: 2,
	id: item.id,
	suite: item.suite,
	source: "test",
	description: "test",
	caseHash: "hash",
	stepKinds: [],
	graders: [],
};
const record: TrialRecord = {
	schemaVersion: 4,
	runId: "run",
	caseId: item.id,
	caseHash: "hash",
	trial: 1,
	observedModel: "mock",
	outcome: "pass",
	grades: [],
	configHashes: ["a", "b", "c"],
	archiveComplete: true,
	result: {
		execution: "completed",
		acceptance: "pass",
		invariants: "intact",
		grading: "complete",
		evidenceComplete: true,
	},
	metrics: {
		costUsd: 1,
		costBasis: "provider",
		tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
		wallMs: 100,
		turns: 1,
		toolCalls: 1,
		segments: 1,
		duplicateExternalEffects: 0,
		userEscalations: 0,
	},
	startedAt: "2026-09-10",
};

describe("eval supervision and evidence", () => {
	it("does not let a held judge block another worker's budget or event persistence", async () => {
		const root = temp();
		const judgePath = join(root, "judge.mjs");
		writeFileSync(
			judgePath,
			'process.stdout.write("ready\\n"); process.stdin.once("data",()=>process.exit(0)); setTimeout(()=>process.exit(1),8000);',
		);
		const workerPath = join(root, "worker.mjs");
		writeFileSync(
			workerPath,
			'process.stdout.write(JSON.stringify({protocol:1,type:"trace",event:{schemaVersion:1,seq:1,segment:1,ts:"2026-09-10",kind:"tool-call",tool:"read"}})+"\\n");setInterval(()=>{},1000);',
		);
		let release: (() => void) | undefined;
		let ready: (() => void) | undefined;
		const readyPromise = new Promise<void>((resolve) => {
			ready = resolve;
		});
		let judged = false;
		const judging = runJudgeProcess({
			workerPath: judgePath,
			args: [],
			homeDir: root,
			timeoutMs: 5000,
			onSpawn: (child) => {
				child.stdout.once("data", () => ready?.());
				release = () => child.stdin.write("release\n");
			},
		}).then((value) => {
			judged = true;
			return value;
		});
		try {
			await readyPromise;
			const worker = await runWorkerSegment({
				item,
				homeDir: root,
				segment: { start: 0, end: 1, mode: "graceful", delayMs: 0 },
				segmentNumber: 1,
				externalBaseUrl: "",
				trace: [],
				deliveries: [],
				usage: { costUsd: 0, turns: 0 },
				deadlineMs: Date.now() + 300,
				workerPath,
				eventLogPath: join(root, "events.jsonl"),
			});
			expect(worker.kind).toBe("budget");
			expect(judged).toBe(false);
			expect(JSON.parse(readFileSync(join(root, "events.jsonl"), "utf8").trim()).event.tool).toBe("read");
		} finally {
			release?.();
			await judging;
		}
	});

	it("hands released pool capacity to queued work exactly once", async () => {
		const pool = new EvalPool(1);
		const release = await pool.acquire();
		let entered = false;
		const next = pool.acquire().then((release) => {
			entered = true;
			return release;
		});
		await Promise.resolve();
		expect(entered).toBe(false);
		release();
		release();
		const releaseNext = await next;
		expect(entered).toBe(true);
		let thirdEntered = false;
		const third = pool.acquire().then((release) => {
			thirdEntered = true;
			release();
		});
		await Promise.resolve();
		expect(thirdEntered).toBe(false);
		releaseNext();
		await third;
	});

	// Mutation: bypassing artifact hash verification makes this tampering regression fail.
	it("regrades saved code evidence while preserving the original false-pass assessment", async () => {
		const root = temp();
		const homeDir = join(root, "home");
		const workspaceDir = join(homeDir, "workspace");
		const channelDir = join(workspaceDir, "dm_eval");
		mkdirSync(channelDir, { recursive: true });
		writeFileSync(join(channelDir, "result.txt"), "broken; claimed complete");
		writeFileSync(join(workspaceDir, "code.ts"), "x".repeat(70000));
		mkdirSync(join(homeDir, ".eval-hidden"));
		writeFileSync(join(homeDir, ".eval-hidden/evaluator.mjs"), "hidden\n");
		const trialDir = join(root, "trial");
		const index = captureArtifacts({ homeDir, workspaceDir, channelDir }, trialDir, [
			{ root: "workspace", path: "." },
			{ root: "home", path: ".eval-hidden/evaluator.mjs" },
		]);
		expect(index.entries.some((entry) => entry.id === "workspace/code.ts" && entry.status === "complete")).toBe(true);
		expect(index.entries.some((entry) => entry.id === "home/.eval-hidden/evaluator.mjs")).toBe(true);
		atomicJson(join(trialDir, "record.json"), record);
		atomicJson(join(trialDir, "outcome.json"), {
			schemaVersion: 1,
			deliveries: [],
			canaries: [],
			fileTree: [],
			externalRequests: [],
		});
		writeFileSync(join(trialDir, "trace.jsonl"), "");
		sealArtifactIndex(trialDir, index, ["record.json", "outcome.json", "trace.jsonl"]);
		const original = readFileSync(join(trialDir, "record.json"), "utf8");
		rmSync(homeDir, { recursive: true });
		const assessment = await regradeTrial(trialDir, item, join(root, "assessment"));
		const reassessment = JSON.parse(readFileSync(assessment, "utf8"));
		expect(reassessment.outcome).toBe("fail");
		expect(reassessment.grades).toContainEqual(
			expect.objectContaining({ graderId: "hidden-evaluator-restored", status: "pass" }),
		);
		expect(readFileSync(join(trialDir, "record.json"), "utf8")).toBe(original);
		expect(readFileSync(join(trialDir, "artifacts/workspace/dm_eval/result.txt"), "utf8")).toBe(
			"broken; claimed complete",
		);
		writeFileSync(join(trialDir, "artifacts/workspace/dm_eval/result.txt"), "fixed");
		expect(() => verifyArtifacts(trialDir)).toThrow(/changed/);
	});

	it("keeps completed behavioral failures and archives interrupted attempts separately", () => {
		const root = temp();
		const trialDir = join(root, "trial");
		atomicJson(join(trialDir, "record.json"), { ...record, outcome: "fail" });
		expect(completedTrial(trialDir, "run", descriptor, 1)?.outcome).toBe("fail");
		expect(() => preserveInterruptedAttempt(trialDir)).toThrow(/completed/);
		rmSync(join(trialDir, "record.json"));
		writeFileSync(join(trialDir, "events.jsonl"), "partial evidence\n");
		const archived = preserveInterruptedAttempt(trialDir)!;
		expect(readFileSync(join(archived, "events.jsonl"), "utf8")).toBe("partial evidence\n");
		expect(completedTrial(trialDir, "run", descriptor, 1)).toBeUndefined();
	});
});

describe("eval resource accounting", () => {
	const entry = (kind: UsageLedgerEntry["kind"], amount: number): UsageLedgerEntry => ({
		ts: "2026-09-10",
		channelId: "dm_eval",
		kind,
		model: "fixture",
		usage: { input: amount, output: 0, cacheRead: 0, cacheWrite: 0, total: amount },
		cost: { input: amount, output: 0, cacheRead: 0, cacheWrite: 0, total: amount },
	});
	it("accounts for all product actors without counting delegation settlement twice", () => {
		const sub = { ...entry("subagent", 2), runId: "run-a" };
		const usage = summarizeResources([entry("turn", 1), sub, entry("sidecar", 3), sub]);
		expect(usage.agentCostUsd).toBe(6);
		expect(usage.byKind.subagent.entries).toBe(1);
		// Identical turn rows may be two real calls; content equality is not an idempotency key.
		expect(summarizeResources([entry("turn", 1), entry("turn", 1)]).agentCostUsd).toBe(2);
	});
	it("keeps unpriced calls and incomplete ledger writes unknown instead of free", () => {
		const unknown = { ...entry("subagent", 0), usageKnown: false, costKnown: false };
		expect(summarizeResources([entry("turn", 1), unknown]).agentCostUsd).toBeNull();
		expect(summarizeResources([entry("turn", 1)], false).agentCostUsd).toBeNull();
		const root = temp();
		mkdirSync(join(root, "state/usage"), { recursive: true });
		writeFileSync(join(root, "state/usage/usage-2026-09.jsonl"), `${JSON.stringify(entry("turn", 1))}\n{"partial":`);
		expect(readResourceLedger(root)).toMatchObject({ complete: false, entries: [entry("turn", 1)] });
	});
});
