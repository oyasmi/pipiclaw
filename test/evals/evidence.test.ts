import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allCases } from "../../evals/cases/index.js";
import { atomicJson, captureArtifacts, sealArtifactIndex, verifyArtifacts } from "../../evals/harness/artifacts.js";
import { setSelectedCasesEnvironment } from "../../evals/harness/cli.js";
import { runCycle } from "../../evals/harness/cycle.js";
import { fileContains } from "../../evals/harness/graders.js";
import { runJudgeProcess } from "../../evals/harness/judge-process.js";
import { EvalPool } from "../../evals/harness/pool.js";
import { regradeTrial } from "../../evals/harness/regrade.js";
import { readResourceLedger, summarizeResources } from "../../evals/harness/resources.js";
import { completedTrial, preserveInterruptedAttempt } from "../../evals/harness/resume.js";
import { runWorkerSegment } from "../../evals/harness/run.js";
import type {
	CapturedDelivery,
	CaseDescriptor,
	EvalCase,
	TraceEvent,
	TrialRecord,
} from "../../evals/harness/schema.js";
import type { UsageLedgerEntry } from "../../src/usage/ledger.js";
import { reply } from "../support/mock-provider/script.js";
import { startMockProvider } from "../support/mock-provider/server.js";
import * as setup from "../support/setup.js";
import { createDeterministicHome } from "../support/setup.js";

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
	it("boots the actual eval worker and observes a provider request and delivery through the transport", async () => {
		// Regression: the eval-only bot omitted getCardGeneration; runtime swallowed its TypeError,
		// no model was called, and every case became a misleading behavioral failure. The subprocess
		// probes below use test-owned worker scripts and cannot catch this production-port drift.
		// Mutation checked 2026-10-14: original missing method => 0 requests, this case red.
		// Mutation checked 057: removing compiled worker chdir produced the source checkout in stdout; this test went red.
		const model = await startMockProvider();
		try {
			model.script.route({
				name: "eval-worker",
				when: (request) => request.isMainTurn,
				respond: [reply.toolCall("bash", { command: "pwd" }), reply.text("评测接线完成。")],
				repeat: true,
			});
			const home = createDeterministicHome({ homeDir: temp(), mockBaseUrl: model.baseUrl });
			const probe = allCases.find((entry) => entry.id === "S-inject-core-01")!;
			const trace: TraceEvent[] = [];
			const deliveries: CapturedDelivery[] = [];
			const result = await runWorkerSegment({
				item: probe,
				homeDir: home.homeDir,
				preparedHome: true,
				segment: { start: 0, end: probe.script.length, mode: "graceful", delayMs: 0 },
				segmentNumber: 1,
				externalBaseUrl: "",
				trace,
				deliveries,
				usage: { costUsd: 0, turns: 0 },
				deadlineMs: Date.now() + 15_000,
			});
			expect(result.kind).toBe("complete");
			expect(model.requests.filter((request) => request.isMainTurn)).toHaveLength(2);
			const shellResult = trace.find((entry) => entry.kind === "tool-result" && entry.tool === "bash");
			const body = JSON.parse(shellResult!.fields!.detail!) as { content: Array<{ text?: string }> };
			expect(
				body.content
					.map((part) => part.text ?? "")
					.join("\n")
					.trim(),
			).toBe(home.workspaceDir);
			expect(trace.some((entry) => entry.kind === "model-result")).toBe(true);
			expect(deliveries.some((delivery) => delivery.method === "sendPlain")).toBe(true);
			expect(model.unmatched()).toHaveLength(0);
		} finally {
			await model.close();
		}
	});

	it("rejects a cycle whose compiled inputs change while a real provider call is held", async () => {
		// New failure: rebuilding during a long eval could mix worker versions under one frozen
		// plan and publish a misleading reference. Direct-worker tests do not run this chain.
		// Net eval-tooling growth +1; no deterministic e2e growth. Mutation checked 2026-10-15:
		// forcing executionDrift=false made this test return 0 instead of 2 (red).
		const provider = await startMockProvider();
		provider.script.route({
			name: "frozen-cycle",
			when: (request) => request.isMainTurn,
			respond: [reply.text("DOCUMENT-LABEL-7")],
			repeat: true,
		});
		const hold = provider.script.hold({ when: (request) => request.isMainTurn });
		const previousEnv = { ...process.env };
		const previousExit = process.exitCode;
		const availability = vi.spyOn(setup, "canRunE2E").mockReturnValue(true);
		const home = vi
			.spyOn(setup, "createE2ETestHome")
			.mockImplementation((options) =>
				createDeterministicHome({ homeDir: options?.homeDir, mockBaseUrl: provider.baseUrl }),
			);
		let output = "";
		const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			output += String(chunk);
			return true;
		});
		const changed = join(process.cwd(), "dist-evals/compiled-drift-probe.js");
		let work: Promise<void> | undefined;
		try {
			for (const key of Object.keys(process.env))
				if (key.startsWith("EVAL_") || key.startsWith("PIPICLAW_E2E_")) delete process.env[key];
			work = runCycle(["--case", "S-inject-core-01"], setSelectedCasesEnvironment);
			await hold.arrived;
			writeFileSync(changed, "export const changedDuringExecution=true;\n");
			hold.release();
			await work;
			const path = /Cycle report: (.+)\/cycle\.md/.exec(output)?.[1];
			expect(path).toBeDefined();
			roots.push(path!);
			const state = JSON.parse(readFileSync(join(path!, "execution-state.json"), "utf8"));
			expect(state.status).toBe("changed");
			expect(process.exitCode).toBe(2);
			expect(JSON.parse(readFileSync(join(path!, "cycle.json"), "utf8")).exitCode).toBe(2);
			expect(existsSync(join(process.cwd(), "evals/results/references", path!.split("/").at(-1)!))).toBe(false);
			expect(provider.requests.filter((request) => request.isMainTurn)).toHaveLength(1);
		} finally {
			hold.release();
			if (work) await work.catch(() => {});
			rmSync(changed, { force: true });
			availability.mockRestore();
			home.mockRestore();
			stdout.mockRestore();
			process.exitCode = previousExit;
			for (const key of new Set([...Object.keys(process.env), ...Object.keys(previousEnv)]))
				if (key.startsWith("EVAL_") || key.startsWith("PIPICLAW_")) {
					if (previousEnv[key] === undefined) delete process.env[key];
					else process.env[key] = previousEnv[key];
				}
			await provider.close();
		}
	}, 20_000);

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
		const deskDir = join(workspaceDir, "desk-eval");
		mkdirSync(deskDir, { recursive: true });
		writeFileSync(join(deskDir, "result.txt"), "broken; claimed complete");
		writeFileSync(join(workspaceDir, "code.ts"), "x".repeat(70000));
		mkdirSync(join(homeDir, ".eval-hidden"));
		writeFileSync(join(homeDir, ".eval-hidden/evaluator.mjs"), "hidden\n");
		const trialDir = join(root, "trial");
		const index = captureArtifacts({ homeDir, workspaceDir, deskDir }, trialDir, [
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
		expect(readFileSync(join(trialDir, "artifacts/workspace/desk-eval/result.txt"), "utf8")).toBe(
			"broken; claimed complete",
		);
		writeFileSync(join(trialDir, "artifacts/workspace/desk-eval/result.txt"), "fixed");
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
		const sidecar = entry("sidecar", 3);
		sidecar.usage.total = 0;
		const normalized = summarizeResources([sidecar]);
		expect(normalized.byKind.sidecar.tokens.total).toBe(3);
		expect(normalized.byKind.sidecar.reconstructedTokenTotals).toBe(1);
		expect(sidecar.usage.total).toBe(0); // retain original accounting evidence
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
