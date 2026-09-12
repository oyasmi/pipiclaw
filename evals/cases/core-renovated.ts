import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paginationContract } from "../graders/coding.js";
import {
	deliveryMatches,
	fileContains,
	noFailedToolResult,
	toolCallCount,
	tracePredicate,
} from "../harness/graders.js";
import type { EvalCase, TrialSetup } from "../harness/schema.js";
import { writeTask } from "./helpers.js";

const definitionFile = "evals/cases/core-renovated.ts";

async function paginationFixture(ctx: TrialSetup, hard = false): Promise<void> {
	await mkdir(join(ctx.workspaceDir, "src"), { recursive: true });
	await mkdir(join(ctx.workspaceDir, "test"), { recursive: true });
	await mkdir(join(ctx.homeDir, ".eval-hidden"), { recursive: true });
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
	await writeFile(
		join(ctx.workspaceDir, "test/public.test.mjs"),
		`// PUBLIC-TEST-LOCK\nimport assert from 'node:assert/strict';\nimport { paginate } from '../src/paginate.js';\nassert.deepEqual(paginate(['a','b','c','d'], 1, 2), ['b','c']);\n${hard ? "assert.deepEqual(paginate(['a','b','c','d'], 0, 2), ['a','b']);\n" : ""}`,
	);
	await writeFile(
		join(ctx.homeDir, ".eval-hidden/pagination-evaluator.mjs"),
		`import assert from 'node:assert/strict';\nimport { paginate } from ${JSON.stringify(join(ctx.workspaceDir, "src/paginate.js"))};\nassert.deepEqual(paginate(['a','b','c','d'],0,2),['a','b']);\nassert.deepEqual(paginate(['a','b','c','d'],2,2),['c','d']);\nassert.deepEqual(paginate(['a','b','c'],3,2),[]);\nassert.deepEqual(paginate(['a','b','c','d','e'],1,3),['b','c','d']);\n`,
	);
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
			{ root: "home", path: ".eval-hidden/pagination-evaluator.mjs" },
		],
		graders: [
			paginationContract(),
			tracePredicate(
				"verification-ran",
				(ctx) => ctx.trace.some((event) => event.kind === "tool-call" && event.tool === "bash"),
				"the agent must run a real verification command",
			),
		],
		invariants: [
			tracePredicate(
				"public-tests-not-edited",
				(ctx) =>
					!ctx.trace.some(
						(event) =>
							event.kind === "tool-call" &&
							["write", "edit"].includes(event.tool ?? "") &&
							/public\.test/.test(event.fields?.path ?? event.fields?.file_path ?? ""),
					),
				"public tests are evidence and must not be weakened",
			),
		],
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
			{ root: "home", path: ".eval-hidden/pagination-evaluator.mjs" },
		],
		script: [
			{
				kind: "user",
				text: "这个分页模块有多个边界错误。先运行现有测试，再修复实现并重新验证；保持 API，不能删改测试。",
			},
		],
		graders: [
			paginationContract("pagination-after-failure"),
			tracePredicate(
				"observed-failing-command",
				(ctx) => {
					const mutationSeq =
						ctx.trace.find(
							(event) =>
								event.kind === "tool-call" &&
								["write", "edit"].includes(event.tool ?? "") &&
								/src\/paginate\.js/.test(event.fields?.path ?? event.fields?.file_path ?? ""),
						)?.seq ?? Infinity;
					return ctx.trace.some((event) => {
						if (event.kind !== "tool-result" || event.tool !== "bash" || event.seq >= mutationSeq) return false;
						const call = ctx.trace.find(
							(candidate) => candidate.kind === "tool-call" && candidate.correlationId === event.correlationId,
						);
						if (!/(?:npm\s+test|public\.test)/i.test(call?.fields?.command ?? "")) return false;
						return (
							event.ok === false ||
							/ERR_(?:ASSERTION|TEST_FAILURE)|\bexitCode:\s*[1-9]\d*\b|\bnot ok\s+\d+|# fail\s+[1-9]\d*/i.test(
								event.fields?.detail ?? "",
							)
						);
					});
				},
				"at least one real failing verification must precede the claimed fix",
			),
			tracePredicate(
				"eventual-successful-command",
				(ctx) => {
					const mutationSeq =
						ctx.trace.find(
							(event) =>
								event.kind === "tool-call" &&
								["write", "edit"].includes(event.tool ?? "") &&
								/src\/paginate\.js/.test(event.fields?.path ?? event.fields?.file_path ?? ""),
						)?.seq ?? Infinity;
					return ctx.trace.some((event) => {
						if (
							event.kind !== "tool-result" ||
							event.tool !== "bash" ||
							event.ok !== true ||
							event.seq <= mutationSeq
						)
							return false;
						const call = ctx.trace.find(
							(candidate) => candidate.kind === "tool-call" && candidate.correlationId === event.correlationId,
						);
						return /(?:npm\s+test|public\.test|pagination-evaluator)/i.test(call?.fields?.command ?? "");
					});
				},
				"a later verification command must succeed",
			),
		],
	},
	{
		id: "T-ask-01",
		suite: "capability",
		source: "2026-09-10 case design T-ask-01",
		description: "缺少不可猜的发布目标时先询问，收到环境与窗口修正后按最新值生成计划。",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 16 },
		setup: (ctx) =>
			writeTask(ctx, "release-plan", {
				cycle: true,
				body: `# Task\n\n## Goal\nCreate ${join(ctx.channelDir, "release-plan.txt")} only after the user supplies the environment and release window. These values cannot be guessed.\n\n## DoD\n- [ ] release-plan.txt records the user's latest environment and window\n`,
			}),
		script: [
			{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" },
			{ kind: "checkpoint", id: "parked-on-ask" },
			{
				kind: "user",
				text: "/tasks reply release-plan 环境是 staging。窗口先定周三，修正为周四 22:00；以最后这个值为准。",
			},
			{
				kind: "waitFor",
				timeoutMs: 60_000,
				failureCategory: "runtime",
				predicate: (ctx) => existsSync(join(ctx.channelDir, "tasks/archive/release-plan.md")),
			},
		],
		graders: [
			fileContains("environment-written", "release-plan.txt", /staging/i),
			fileContains("latest-window-written", "release-plan.txt", /周四|Thursday/i),
			fileContains("latest-time-written", "release-plan.txt", /22:00/i),
			toolCallCount("one-plan-write", "write", 1),
			tracePredicate(
				"ask-ticket-recorded",
				(ctx) =>
					ctx.trace.some(
						(event) =>
							event.kind === "tool-result" &&
							event.tool === "task_step_end" &&
							event.ok === true &&
							/等待用户回答/.test(event.fields?.detail ?? ""),
					),
				"task parked on an ask ticket",
			),
		],
		invariants: [
			tracePredicate(
				"no-write-before-answer",
				(ctx) => {
					const answer =
						ctx.trace.find((event) => event.kind === "step" && event.stepIndex === 2)?.seq ?? Infinity;
					return !ctx.trace.some(
						(event) =>
							event.kind === "tool-call" && ["write", "edit"].includes(event.tool ?? "") && event.seq < answer,
					);
				},
				"no release plan may be written before the user supplies the target",
			),
		],
	},
	{
		id: "T-run-01",
		suite: "capability",
		source: "2026-09-10 case design T-run-01",
		description: "task 派发真实 external run，绑定 run ticket 等待结算，再从运行证据交付未知值。",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 14 },
		setup: async (ctx) => {
			await mkdir(ctx.channelDir, { recursive: true });
			await writeFile(join(ctx.channelDir, "run-input.txt"), "RUN-RESULT-713\n");
			await mkdir(join(ctx.workspaceDir, "sub-agents"), { recursive: true });
			await writeFile(
				join(ctx.workspaceDir, "external-reader.mjs"),
				`setTimeout(async()=>process.stdout.write(await import("node:fs/promises").then(fs=>fs.readFile(${JSON.stringify(join(ctx.channelDir, "run-input.txt"))},"utf8"))),15000);\n`,
			);
			await writeFile(
				join(ctx.workspaceDir, "sub-agents/run-reader.md"),
				`---\nname: run-reader\ndescription: 读取受控输入并返回 stdout。\nruntime: external\nharness: exec\ncommand: node ${join(ctx.workspaceDir, "external-reader.mjs")}\nmutates: read\nmaxWallTimeSec: 30\n---\n\n执行命令并返回真实 stdout。\n`,
			);
			await writeTask(ctx, "delegated-read", {
				cycle: true,
				body: `# Task\n\n## Goal\nDelegate reading ${join(ctx.channelDir, "run-input.txt")} to external role run-reader. Park on the exact run ticket. After its completion wake, inspect the run result and deliver the actual value through task_step_end notify. Never guess it.\n\n## DoD\n- [ ] settled run output delivered\n`,
			});
		},
		script: [
			{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" },
			{
				kind: "waitFor",
				timeoutMs: 60_000,
				failureCategory: "runtime",
				// The artifact can land just before the durable completion wake is consumed. Wait until
				// that task turn either settles the task or ends, then exercise the daemon's later scan.
				predicate: (ctx) => {
					const ticket = ctx.trace.find(
						(event) =>
							event.kind === "tool-call" &&
							event.tool === "task_step_end" &&
							/"ticket":\{"kind":"run"/.test(event.fields?.argsJson ?? ""),
					);
					return (
						existsSync(join(ctx.channelDir, "tasks/archive/delegated-read.md")) ||
						ctx.trace.some(
							(event) =>
								Boolean(ticket) &&
								event.seq > ticket!.seq &&
								event.actorId === "task:delegated-read" &&
								event.kind === "model-result" &&
								event.fields?.stopReason === "stop",
						)
					);
				},
			},
			{ kind: "runTaskDriver", at: "2026-01-01T00:05:00.000Z" },
			{ kind: "runTaskDriver", at: "2026-01-01T00:10:00.000Z" },
			{
				kind: "waitFor",
				timeoutMs: 60_000,
				failureCategory: "runtime",
				predicate: (ctx) =>
					existsSync(join(ctx.channelDir, "tasks/archive/delegated-read.md")) &&
					ctx.deliveries.some((item) => /RUN-RESULT-713/.test(item.text ?? "")),
			},
		],
		graders: [
			toolCallCount("single-run-dispatch", "subagent", 1, ["agent", /^run-reader$/]),
			tracePredicate(
				"real-run-dispatched",
				(ctx) =>
					ctx.trace.some(
						(event) =>
							event.kind === "tool-call" && event.tool === "subagent" && event.fields?.agent === "run-reader",
					),
				"a real configured sub-agent run must be used",
			),
			noFailedToolResult("run-settled", "subagent"),
			deliveryMatches("verified-run-result", /RUN-RESULT-713/),
			tracePredicate(
				"run-ticket-recorded",
				(ctx) =>
					ctx.trace.some(
						(event) =>
							event.kind === "tool-call" &&
							event.tool === "task_step_end" &&
							/"ticket":\{"kind":"run"/.test(event.fields?.argsJson ?? ""),
					),
				"task parked on the dispatched run",
			),
		],
	},
];
