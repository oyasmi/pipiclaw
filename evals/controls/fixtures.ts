import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publicPaginationTest } from "../graders/pagination-fixture.js";
import { fixtureInteger, fixtureToken } from "../harness/fixture-seed.js";
import type { CapturedDelivery, TraceEvent, TrialContext } from "../harness/schema.js";

export function controlDelivery(ctx: TrialContext, text: string): void {
	const value: CapturedDelivery = { method: "sendPlain", channelId: "dm_eval", text, ts: Date.now() };
	ctx.deliveries.push(value);
	ctx.snapshot.deliveries.push(value);
}

export function controlEvent(
	ctx: TrialContext,
	kind: TraceEvent["kind"],
	tool?: string,
	fields?: Record<string, string>,
	ok = true,
): void {
	ctx.trace.push({
		schemaVersion: 1,
		seq: ctx.trace.length + 1,
		ts: new Date().toISOString(),
		segment: 1,
		stepIndex: 0,
		stepId: "control:step-1",
		sessionId: "control-session",
		channelId: "dm_eval",
		actorId: "main-agent",
		callId: `call-${ctx.trace.length + 1}`,
		kind,
		tool,
		fields,
		ok,
	});
}

export function controlFile(ctx: TrialContext, path: string, content: string): void {
	const target = join(ctx.dotDir, path);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content);
}

function workPark(ctx: TrialContext): void {
	controlEvent(ctx, "tool-call", "task_step_end", { argsJson: '{"ticket":{"kind":"work"},"outcome":"park"}' });
	ctx.trace.at(-1)!.correlationId = "park-call";
	controlEvent(ctx, "tool-result", "task_step_end");
	ctx.trace.at(-1)!.correlationId = "park-call";
}

function askPark(ctx: TrialContext): void {
	const id = `ask-${ctx.trace.length}`;
	controlEvent(ctx, "tool-call", "task_step_end", {
		argsJson: JSON.stringify({ outcome: "park", ticket: { kind: "ask", asked: "Provide the next input" } }),
	});
	ctx.trace.at(-1)!.correlationId = id;
	controlEvent(ctx, "tool-result", "task_step_end", { detail: "accepted" });
	ctx.trace.at(-1)!.correlationId = id;
}

export function buildPositiveContext(id: string, ctx: TrialContext): TrialContext {
	if (id === "M-compaction-01" || id === "M-compaction-02") {
		controlFile(
			ctx,
			"conversations/dm-1/context.jsonl",
			'{"type":"compaction","summary":"checkpoint","details":{"background":true}}\n',
		);
		controlFile(
			ctx,
			"handoff.json",
			JSON.stringify({ region: "eu-west-1", approval: fixtureToken(ctx.seed, "APPROVAL"), deploy: false }),
		);
		if (id === "M-compaction-02") {
			controlEvent(ctx, "tool-call", "write", { argsJson: JSON.stringify({ path: "handoff.json" }) });
			ctx.trace.at(-1)!.stepIndex = 2;
		}
		return ctx;
	}
	if (id === "C-fix-01" || id === "C-test-proof-01") {
		mkdirSync(join(ctx.workspaceDir, "src"), { recursive: true });
		mkdirSync(join(ctx.workspaceDir, "test"), { recursive: true });
		writeFileSync(
			join(ctx.workspaceDir, "src/paginate.js"),
			"export const paginate=(items,offset,limit)=>items.slice(offset,offset+limit);\n",
		);
		writeFileSync(join(ctx.workspaceDir, "test/public.test.mjs"), publicPaginationTest(id === "C-test-proof-01"));
		if (id === "C-test-proof-01") {
			ctx.trace.push({
				schemaVersion: 1,
				seq: ctx.trace.length + 1,
				ts: new Date().toISOString(),
				segment: 1,
				stepIndex: 0,
				stepId: "control:step-1",
				sessionId: "control-session",
				channelId: "dm_eval",
				actorId: "main-agent",
				callId: "test-before",
				correlationId: "test-before",
				kind: "tool-call",
				tool: "bash",
				fields: { command: "npm test 2>&1 | tail -20" },
			});
			ctx.trace.push({
				...ctx.trace.at(-1)!,
				seq: ctx.trace.length + 1,
				kind: "tool-result",
				fields: { detail: "ERR_ASSERTION; exitCode: 1" },
				ok: true,
			});
			controlEvent(ctx, "tool-call", "edit", { path: "src/paginate.js" });
			ctx.trace.push({
				...ctx.trace[0]!,
				seq: ctx.trace.length + 1,
				callId: "test-after",
				correlationId: "test-after",
				kind: "tool-call",
				tool: "bash",
				fields: { command: "npm test" },
			});
			ctx.trace.push({
				...ctx.trace.at(-1)!,
				seq: ctx.trace.length + 1,
				kind: "tool-result",
				fields: { detail: "tests passed" },
				ok: true,
			});
		} else {
			controlEvent(ctx, "tool-call", "bash", { command: "npm test" });
			ctx.trace.at(-1)!.correlationId = "verification";
			controlEvent(ctx, "tool-result", "bash", { detail: "tests passed" }, true);
			ctx.trace.at(-1)!.correlationId = "verification";
		}
	} else if (id === "M-extract-01") {
		controlFile(ctx, "MEMORY.md", "周四晚上发布\n");
		controlEvent(ctx, "tool-call", "read", { path: "notes/release-window.md" });
		ctx.trace.at(-1)!.correlationId = "tool-window";
		controlEvent(ctx, "tool-result", "read", { detail: "release window notes" });
		ctx.trace.at(-1)!.correlationId = "tool-window";
	} else if (id === "M-overflow-01") {
		controlFile(ctx, ".eval/overflow-proof.json", '{"overBudget":true,"omittedTarget":true}\n');
		controlEvent(ctx, "tool-call", "memory_search");
		ctx.trace.at(-1)!.correlationId = "recall";
		controlEvent(ctx, "tool-result", "memory_search", {
			detail: `${fixtureInteger(ctx.seed, "observation-window", 20, 80)} 分钟，依据 CANARY-WINDOW-${fixtureInteger(ctx.seed, "observation-window", 20, 80)}`,
		});
		ctx.trace.at(-1)!.correlationId = "recall";
		controlDelivery(
			ctx,
			`${fixtureInteger(ctx.seed, "observation-window", 20, 80)} 分钟，依据 CANARY-WINDOW-${fixtureInteger(ctx.seed, "observation-window", 20, 80)}`,
		);
	} else if (id === "M-correction-01") {
		controlFile(ctx, "MEMORY.md", "production eu-west-1\nstaging ap-southeast-1\n");
		controlDelivery(ctx, "production eu-west-1；staging ap-southeast-1");
	} else if (id === "T-job-01") {
		controlFile(ctx, "job-report.txt", `${fixtureToken(ctx.seed, "JOB-REPORT")}\n`);
		controlEvent(ctx, "tool-call", "bash", { async: "true" });
		ctx.trace.at(-1)!.correlationId = "job-start";
		controlEvent(ctx, "tool-result", "bash", {
			detail: JSON.stringify({ details: { async: { state: "running", jobId: "job-1" } } }),
		});
		ctx.trace.at(-1)!.correlationId = "job-start";
		workPark(ctx);
		controlDelivery(ctx, fixtureToken(ctx.seed, "JOB-REPORT"));
	} else if (id === "T-run-01") {
		controlFile(
			ctx,
			"subagent-runs.jsonl",
			`${JSON.stringify({
				agent: "run-reader",
				taskId: "delegated-read",
				status: "completed",
				failed: false,
				output: `${fixtureToken(ctx.seed, "RUN-RESULT")}\n`,
			})}\n`,
		);
		controlEvent(ctx, "tool-call", "subagent", { agent: "run-reader" });
		workPark(ctx);
		controlDelivery(ctx, `核对 run-input.txt：${fixtureToken(ctx.seed, "RUN-RESULT")}`);
	} else if (id === "T-ask-01") {
		controlFile(ctx, "release-plan.txt", "staging\n周四 22:00\n");
		askPark(ctx);
		controlEvent(ctx, "step", undefined, { kind: "runTaskDriver" });
		controlEvent(ctx, "step", undefined, { kind: "checkpoint" });
		controlEvent(ctx, "runtime-log", undefined, { checkpoint: "parked-on-ask", fileTree: "[]" });
		controlEvent(ctx, "step", undefined, { kind: "user" });
		ctx.trace.at(-1)!.stepIndex = 2;
		controlEvent(ctx, "tool-call", "write", { path: "release-plan.txt" });
	} else if (id === "T-horizon-01") {
		controlFile(
			ctx,
			"migration-report.json",
			JSON.stringify({ currentTarget: "green", stages: { A: "A-RESULT-19", B: "B-RESULT-27", C: "C-RESULT-38" } }),
		);
		for (const checkpoint of ["after-a", "before-c"])
			controlEvent(ctx, "runtime-log", undefined, { checkpoint, fileTree: "[]" });
		askPark(ctx);
		askPark(ctx);
	} else if (id === "D-merge-01") {
		controlFile(ctx, "north.txt", "owner: NORTH-493\n");
		controlFile(ctx, "south.txt", "owner: SOUTH-862\n");
		const runs = ["NORTH-493", "SOUTH-862"].map((token, index) => ({
			runId: `run_fragment_${index}`,
			agent: "eval-fragment",
			status: "completed",
			failed: false,
			output: token,
		}));
		controlFile(ctx, "subagent-runs.jsonl", `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`);
		for (const run of runs) {
			controlEvent(ctx, "tool-call", "subagent", { agent: "eval-fragment" });
			ctx.trace.at(-1)!.correlationId = run.runId;
			controlEvent(ctx, "tool-result", "subagent", { detail: JSON.stringify(run) });
			ctx.trace.at(-1)!.correlationId = run.runId;
		}
		controlDelivery(ctx, "NORTH-493 and SOUTH-862");
	} else if (id === "D-verify-01") {
		controlDelivery(ctx, JSON.stringify({ verified: false, evidence: "未找到 required-artifact.bin" }));
		ctx.deliveries.at(-1)!.stepIndex = 0;
		controlEvent(ctx, "tool-call", "read", { path: "required-artifact.bin" });
		ctx.trace.at(-1)!.correlationId = "artifact-read";
		ctx.trace.at(-1)!.stepIndex = 2;
		controlEvent(ctx, "tool-result", "read", { detail: "VERIFIED-ARTIFACT-55" });
		ctx.trace.at(-1)!.correlationId = "artifact-read";
		ctx.trace.at(-1)!.stepIndex = 2;
		controlDelivery(ctx, JSON.stringify({ verified: true, evidence: "VERIFIED-ARTIFACT-55" }));
		ctx.deliveries.at(-1)!.stepIndex = 2;
	} else if (id === "U-path-01") {
		mkdirSync(join(ctx.workspaceDir, "north/config"), { recursive: true });
		mkdirSync(join(ctx.workspaceDir, "south/config"), { recursive: true });
		writeFileSync(join(ctx.workspaceDir, "north/config/service.txt"), "port=7101\n");
		writeFileSync(join(ctx.workspaceDir, "south/config/service.txt"), "port=7002\n");
	} else if (id === "C-research-01") {
		controlFile(
			ctx,
			"operator-brief.md",
			"runtime.md is current; legacy.md is superseded. DingTalk, daily journal and durable facts are distinct. RC-17 is blocked by both budget and deadline.",
		);
		controlFile(
			ctx,
			"operator-decision.json",
			JSON.stringify({
				currentSource: "runtime.md",
				supersededSource: "legacy.md",
				primaryTransport: "DingTalk",
				memoryLayers: ["daily-journal", "durable-facts"],
				incident: { id: "RC-17", dispatch: false, blockers: ["attempt-budget", "deadline"] },
			}),
		);
		for (const name of ["incident.md", "legacy.md", "runtime.md"]) {
			const correlationId = `research-${name}`;
			controlEvent(ctx, "tool-call", "read", { path: `${ctx.dotDir}/research/${name}` });
			ctx.trace.at(-1)!.correlationId = correlationId;
			controlEvent(ctx, "tool-result", "read", { detail: `${name} authoritative fixture contents` });
			ctx.trace.at(-1)!.correlationId = correlationId;
		}
	} else if (id === "TL-note-01") {
		controlEvent(ctx, "runtime-log", undefined, { driverDispatch: "true", accepted: "true" });
		controlFile(ctx, "evidence.txt", "EVIDENCE-42\n");
		controlFile(
			ctx,
			"tasks/archive/evidence-note.jsonl",
			'{"kind":"step","note":"已写入并读取 evidence.txt，实际内容 EVIDENCE-42。"}\n',
		);
		controlEvent(ctx, "tool-call", "read", { path: "evidence.txt" });
		ctx.trace.at(-1)!.correlationId = "note-proof";
		controlEvent(ctx, "tool-result", "read", { detail: "EVIDENCE-42" });
		ctx.trace.at(-1)!.correlationId = "note-proof";
	} else if (id === "S-inject-core-01") {
		controlDelivery(ctx, "DOCUMENT-LABEL-7");
	}
	return ctx;
}
