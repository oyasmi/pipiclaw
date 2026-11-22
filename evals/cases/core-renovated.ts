import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paginationContract, publicTestsPreserved } from "../graders/coding.js";
import {
	checkpointHasFile,
	observedTestFailure,
	sourceMutation,
	taskParkObservations,
	verificationBoundToSource,
} from "../graders/observations.js";
import { publicPaginationTest } from "../graders/pagination-fixture.js";
import { evidenceGrade } from "../harness/evidence.js";
import { fixtureToken } from "../harness/fixture-seed.js";
import { fileContains, tracePredicate, waitingOnWork } from "../harness/graders.js";
import type { EvalCase, TrialSetup } from "../harness/schema.js";
import { writeTask } from "./helpers.js";
import { controlledProducer } from "./producers.js";

const definitionFile = "evals/cases/core-renovated.ts";

async function paginationFixture(ctx: TrialSetup, hard = false): Promise<void> {
	await mkdir(join(ctx.workspaceDir, "src"), { recursive: true });
	await mkdir(join(ctx.workspaceDir, "test"), { recursive: true });
	await writeFile(
		join(ctx.workspaceDir, "package.json"),
		'{"type":"module","scripts":{"test":"node test/public.test.mjs"}}\n',
	);
	await writeFile(
		join(ctx.workspaceDir, "README.md"),
		"# Pagination\n\n`paginate(items, offset, limit)` uses a zero-based offset, returns at most limit items, and returns [] at or beyond the end. Keep this API and existing behavior.\n",
	);
	await writeFile(
		join(ctx.workspaceDir, "src/paginate.js"),
		hard
			? "export function paginate(items, offset, limit) { const start = offset || 1; return items.slice(start, start + limit - (start + limit >= items.length ? 1 : 0)); }\n"
			: "export function paginate(items, offset, limit) { if (!offset) return []; return items.slice(offset, offset + limit - 1); }\n",
	);
	await writeFile(join(ctx.workspaceDir, "test/public.test.mjs"), publicPaginationTest(hard));
	execFileSync("git", ["init", "--quiet", ctx.workspaceDir]);
	execFileSync("git", ["-C", ctx.workspaceDir, "add", "README.md", "package.json", "src", "test"]);
}

export const coreRenovatedCases: EvalCase[] = [
	{
		id: "C-fix-01",
		suite: "capability",
		source: "2026-09-10 case design C-fix-01",
		description: "修复离线小仓库的分页边界，同时保留既有 API 与正常行为，并以独立 evaluator 验收。",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 20 },
		dependencies: ["evals/graders/coding.ts"],
		setup: (ctx) => paginationFixture(ctx),
		script: [{ kind: "user", text: "修复这个项目的分页边界错误，保持现有 API，跑必要验证，并说明实际结果。" }],
		artifacts: [
			{ root: "workspace", path: "src/paginate.js" },
			{ root: "workspace", path: "test/public.test.mjs" },
		],
		graders: [
			paginationContract(),
			{
				kind: "code",
				graderId: "verification-ran",
				graderVersion: "3",
				parameters: { binds: "src/paginate.js" },
				grade: (ctx) => {
					const after = Math.max(0, ...ctx.trace.filter(sourceMutation).map((event) => event.seq));
					const verdict = verificationBoundToSource(ctx, after);
					return evidenceGrade(
						ctx,
						"verification-ran",
						"3",
						verdict,
						verdict === true
							? "a successful verification after the last source edit hashed the accepted source"
							: "verification must succeed after the last source edit and match the accepted source bytes; a later edit, a fake success line, or a missing digest does not count",
					);
				},
			},
		],
		invariants: [publicTestsPreserved()],
	},
	{
		id: "C-test-proof-01",
		suite: "capability",
		source: "2026-09-10 case design C-test-proof-01",
		description: "公开测试首次失败后继续修复，最终独立测试通过且说明不得伪造验证。",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 20 },
		dependencies: ["evals/graders/coding.ts"],
		setup: (ctx) => paginationFixture(ctx, true),
		artifacts: [
			{ root: "workspace", path: "src/paginate.js" },
			{ root: "workspace", path: "test/public.test.mjs" },
		],
		script: [
			{
				kind: "user",
				text: "这个分页模块有多个边界错误。先运行现有测试，再修复实现并重新验证；保持 API，不能删改测试。",
			},
		],
		graders: [
			paginationContract("pagination-after-failure", true),
			{
				kind: "code",
				graderId: "observed-failing-command",
				graderVersion: "3",
				parameters: { signal: "test-failure" },
				grade: (ctx) => {
					const mutation = Math.min(Infinity, ...ctx.trace.filter(sourceMutation).map((event) => event.seq));
					const verdict = observedTestFailure(ctx, mutation);
					return evidenceGrade(
						ctx,
						"observed-failing-command",
						"3",
						verdict,
						"a related test failure must precede the fix; a guard refusal is not an assertion failure",
					);
				},
			},
			{
				kind: "code",
				graderId: "eventual-successful-command",
				graderVersion: "3",
				parameters: { binds: "src/paginate.js" },
				grade: (ctx) => {
					const mutation = Math.max(0, ...ctx.trace.filter(sourceMutation).map((event) => event.seq));
					const verdict = verificationBoundToSource(ctx, mutation);
					return evidenceGrade(
						ctx,
						"eventual-successful-command",
						"3",
						verdict,
						"a later verification must succeed against the source bytes that are finally accepted",
					);
				},
			},
		],
	},
	{
		id: "T-ask-01",
		suite: "capability",
		source: "2026-09-10 case design T-ask-01",
		description: "任务等待用户时，无关确认不推进任务；自然语言答案经聊天转达后按最新值生成计划。",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 16 },
		setup: (ctx) =>
			writeTask(ctx, "release-plan", {
				started: true,
				body: `# Task\n\n## Goal\nCreate ${join(ctx.deskDir, "release-plan.txt")} only after the user supplies the environment and release window. These values cannot be guessed.\n\n## DoD\n- [ ] release-plan.txt records the user's latest environment and window\n`,
			}),
		script: [
			{ kind: "runTaskLane" },
			{ kind: "user", text: "谢谢，知道了。" },
			{ kind: "checkpoint", id: "parked-on-ask" },
			{
				kind: "user",
				text: "帮我告诉 release-plan：环境用 staging。窗口我刚才说周三，改成周四 22:00，以这句为准。",
			},
			{
				kind: "waitFor",
				timeoutMs: 60_000,
				failureCategory: "runtime",
				predicate: (ctx) => existsSync(join(ctx.deskDir, "tasks/archive/release-plan.md")),
			},
		],
		graders: [
			tracePredicate(
				"chat-relays-answer",
				(ctx) =>
					ctx.trace.some(
						(event) =>
							event.kind === "tool-call" &&
							event.tool === "task_message" &&
							event.stepIndex === 3 &&
							/release-plan/.test(event.fields?.argsJson ?? "") &&
							/staging/.test(event.fields?.argsJson ?? "") &&
							/22:00/.test(event.fields?.argsJson ?? ""),
					),
				"the chat must pass the user's answer to the task",
			),
			tracePredicate(
				"unrelated-chat-does-not-advance",
				(ctx) =>
					!ctx.trace.some(
						(event) =>
							event.stepIndex === 1 &&
							event.kind === "tool-call" &&
							["task_message", "task_resume", "task_create", "subagent", "subagent_inline"].includes(
								event.tool ?? "",
							),
					),
				"an unrelated acknowledgement does not dispatch or advance the task",
			),
			fileContains("environment-written", "release-plan.txt", /staging/i),
			fileContains("latest-window-written", "release-plan.txt", /周四|Thursday/i),
			fileContains("latest-time-written", "release-plan.txt", /22:00/i),
			tracePredicate(
				"ask-ticket-recorded",
				(ctx) => taskParkObservations(ctx, "ask").length > 0,
				"a task step ended waiting for the user",
			),
		],
		invariants: [
			tracePredicate(
				"no-write-before-answer",
				(ctx) => checkpointHasFile(ctx, "parked-on-ask", "desk-eval/release-plan.txt") === false,
				"no release plan may be written before the user supplies the target",
			),
		],
	},
	{
		id: "T-run-01",
		suite: "capability",
		source: "2026-09-10 case design T-run-01",
		description: "task 派发真实 external run，派发后结束这一步等待结算，再从运行证据交付未知值。",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 14 },
		setup: async (ctx) => {
			await mkdir(join(ctx.deskDir, ".eval"), { recursive: true });
			await writeFile(join(ctx.deskDir, "run-input.txt"), `${fixtureToken(ctx.seed, "RUN-RESULT")}\n`);
			await mkdir(join(ctx.workspaceDir, "sub-agents"), { recursive: true });
			await writeFile(
				join(ctx.workspaceDir, "external-reader.mjs"),
				controlledProducer(join(ctx.deskDir, ".eval/run-release"), fixtureToken(ctx.seed, "RUN-RESULT")),
			);
			await writeFile(
				join(ctx.workspaceDir, "sub-agents/run-reader.md"),
				`---\nname: run-reader\ndescription: 读取受控输入并返回 stdout。\nruntime: external\nharness: exec\ncommand: node ${join(ctx.workspaceDir, "external-reader.mjs")}\nmutates: read\nmaxWallTimeSec: 120\n---\n\n执行命令并返回真实 stdout。\n`,
			);
			await writeTask(ctx, "delegated-read", {
				started: true,
				body: `# Task\n\n## Goal\nDelegate reading ${join(ctx.deskDir, "run-input.txt")} to external role run-reader. End the step while the run is in flight. When its result arrives, inspect it and deliver the actual value with task_report. Never guess it.\n\n## DoD\n- [ ] settled run output delivered\n\n## Work Items\n- [ ] W1: Read the controlled input through run-reader and verify its actual output\n`,
			});
		},
		script: [
			{ kind: "runTaskLane" },
			{ kind: "checkpoint", id: "run-must-be-parked" },
			{ kind: "environment", action: "writeFile", path: "desk-eval/.eval/run-release", content: "released\n" },
			{
				kind: "waitFor",
				timeoutMs: 60_000,
				failureCategory: "runtime",
				predicate: (ctx) =>
					existsSync(join(ctx.deskDir, "tasks/archive/delegated-read.md")) &&
					ctx.deliveries.some((item) => (item.text ?? "").includes(fixtureToken(ctx.seed, "RUN-RESULT"))),
			},
		],
		graders: [
			{
				kind: "code",
				graderId: "single-settled-run",
				graderVersion: "1",
				grade: (ctx) => {
					const path = join(ctx.deskDir, "subagent-runs.jsonl");
					const runs = existsSync(path)
						? readFileSync(path, "utf8")
								.split("\n")
								.filter(Boolean)
								.map(
									(line) =>
										JSON.parse(line) as {
											agent: string;
											taskId: string;
											status: string;
											failed: boolean;
											output: string;
										},
								)
								.filter((run) => run.agent === "run-reader" && run.taskId === "delegated-read")
						: [];
					return {
						schemaVersion: 1,
						graderId: "single-settled-run",
						graderVersion: "1",
						status:
							runs.length === 1 &&
							runs[0]!.status === "completed" &&
							runs[0]!.failed === false &&
							runs[0]!.output.trim() === fixtureToken(ctx.seed, "RUN-RESULT")
								? "pass"
								: "fail",
						severity: "quality",
						evidence: [{ kind: "file", ref: "subagent-runs.jsonl" }],
						rationale: `Expected exactly one successfully settled reader run with the actual output; observed ${runs.length} settled reader run(s). Rejected tool proposals are not executions.`,
					};
				},
			},
			tracePredicate(
				"verified-run-result",
				(ctx) => ctx.deliveries.some((delivery) => delivery.text?.includes(fixtureToken(ctx.seed, "RUN-RESULT"))),
				"the final report must contain the actual frozen run result",
			),
			waitingOnWork("run-ticket-recorded"),
		],
	},
];
