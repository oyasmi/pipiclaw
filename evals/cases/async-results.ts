import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toolObservations } from "../graders/observations.js";
import { fixtureToken } from "../harness/fixture-seed.js";
import { tracePredicate, waitingOnWork } from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { writeTask } from "./helpers.js";
import { controlledProducer } from "./producers.js";

/** A failed asynchronous result stays parked with its task, then informs the resumed leader. */
export const asyncResultCases: EvalCase[] = [
	{
		id: "T-async-failure-01",
		suite: "capability",
		source: "067 asynchronous completion and paused task contract",
		description: "任务暂停期间执行者失败；恢复后依据真实失败输出汇报，不提前推进或重复派发。",
		definitionFile: "evals/cases/async-results.ts",
		budget: { maxWallMs: 240_000, maxTurns: 24 },
		setup: async (ctx) => {
			await mkdir(join(ctx.deskDir, ".eval"), { recursive: true });
			await mkdir(join(ctx.workspaceDir, "sub-agents"), { recursive: true });
			await writeFile(
				join(ctx.workspaceDir, "failure-producer.mjs"),
				`process.exitCode=7;\n${controlledProducer(join(ctx.deskDir, ".eval/failure-release"), fixtureToken(ctx.seed, "FAILURE-EVIDENCE"))}`,
			);
			await writeFile(
				join(ctx.workspaceDir, "sub-agents/failing-reader.md"),
				`---\nname: failing-reader\ndescription: 运行一次受控检查，stdout 是证据，退出码决定成功与否。\nruntime: external\nharness: exec\ncommand: node ${join(ctx.workspaceDir, "failure-producer.mjs")}\nmutates: read\nmaxWallTimeSec: 120\n---\n\n只运行一次，忠实保留失败输出。\n`,
			);
			await writeTask(ctx, "paused-result", {
				started: true,
				body: "# Task\n\n## Goal\nDelegate exactly one check to failing-reader and end the step while it runs. When it settles, inspect its actual status and stdout. A failed check is an expected diagnostic result: never retry, repair or replace it. Report one JSON object with status and evidence through task_report, then finish this diagnostic task. Evidence must come from the execution.\n\n## DoD\n- [ ] actual execution status and stdout reported\n",
			});
		},
		script: [
			{ kind: "runTaskLane" },
			{ kind: "checkpoint", id: "failure-work-parked" },
			{ kind: "user", text: "请暂停 paused-result 任务；已经派发的执行者继续运行，任务等我恢复后再处理结果。" },
			{ kind: "checkpoint", id: "failure-task-paused" },
			{ kind: "environment", action: "writeFile", path: "desk-eval/.eval/failure-release", content: "released\n" },
			{
				kind: "waitFor",
				timeoutMs: 60_000,
				failureCategory: "runtime",
				predicate: (ctx) => {
					const directory = join(ctx.homeDir, "state/subagent-runs/eval");
					return (
						existsSync(directory) &&
						readdirSync(directory)
							.filter((name) => name.endsWith(".json"))
							.some((name) => {
								const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
									taskId?: string;
									status?: string;
									taskAccounted?: boolean;
									wakeEnqueued?: boolean;
								};
								return (
									record.taskId === "paused-result" &&
									record.status === "failed" &&
									record.taskAccounted === true &&
									record.wakeEnqueued === true
								);
							})
					);
				},
			},
			{ kind: "checkpoint", id: "failure-held-while-paused" },
			{ kind: "user", text: "恢复 paused-result 任务；只处理已有执行结果并如实汇报，失败也不要重新派发。" },
			{
				kind: "waitFor",
				timeoutMs: 60_000,
				failureCategory: "runtime",
				predicate: (ctx) => existsSync(join(ctx.deskDir, "tasks/archive/paused-result.md")),
			},
		],
		graders: [
			waitingOnWork("failure-waited-on-work"),
			tracePredicate(
				"pause-and-resume-observed",
				(ctx) =>
					["task_pause", "task_resume"].every((tool) =>
						toolObservations(ctx, tool).some(
							({ call, result }) => result.ok && (call.fields?.argsJson ?? "").includes("paused-result"),
						),
					),
				"the chat must actually pause and resume this task",
			),
			tracePredicate(
				"failure-executed-once",
				(ctx) => {
					const path = join(ctx.deskDir, "subagent-runs.jsonl");
					const runs = existsSync(path)
						? readFileSync(path, "utf8")
								.trim()
								.split("\n")
								.filter(Boolean)
								.map(
									(line) =>
										JSON.parse(line) as {
											taskId?: string;
											agent?: string;
											status?: string;
											failed?: boolean;
											output?: string;
										},
								)
								.filter((run) => run.taskId === "paused-result")
						: [];
					return (
						runs.length === 1 &&
						runs[0].agent === "failing-reader" &&
						runs[0].status === "failed" &&
						runs[0].failed === true &&
						runs[0].output?.trim() === fixtureToken(ctx.seed, "FAILURE-EVIDENCE")
					);
				},
				"exactly one real failed execution must supply the evidence; no retries or substitutions",
			),
			tracePredicate(
				"failure-reported-honestly",
				(ctx) =>
					ctx.deliveries.some(
						(delivery) =>
							delivery.stepIndex !== undefined &&
							delivery.stepIndex >= 7 &&
							(delivery.text ?? "").includes(fixtureToken(ctx.seed, "FAILURE-EVIDENCE")) &&
							/"status"\s*:\s*"failed"/.test(delivery.text ?? ""),
					),
				"the resumed task must report the actual failed status and frozen stdout",
			),
		],
		invariants: [
			tracePredicate(
				"no-step-while-paused",
				(ctx) =>
					!ctx.trace.some(
						(event) =>
							event.fields?.taskId === "paused-result" &&
							event.fields.taskStep === "started" &&
							(event.stepIndex ?? -1) >= 3 &&
							(event.stepIndex ?? -1) <= 6,
					),
				"completion must not make the paused task continue",
			),
		],
	},
];
