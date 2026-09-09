import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	deliveryMatches,
	noFailedToolResult,
	readTaskLoopLog,
	taskFrontmatter,
	taskLog,
	toolCallCount,
} from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { writeTask } from "./helpers.js";

const definitionFile = "evals/cases/task-loop-quality.ts";

/**
 * Spec 051 §10: the behavioural evidence for the redesign's three claims — the loop picks a
 * ticket that actually names its blocker, its step notes carry evidence rather than intent, and a
 * budget stop leaves the user something they can act on. Mechanism is covered by the deterministic
 * e2e layer; what a real model *chooses* is only observable here.
 *
 * These are not a gate (`npm run eval` is not part of `npm run check`).
 */

export const taskLoopQualityCases: EvalCase[] = [
	{
		id: "TL-signal-01",
		suite: "capability",
		source: "2026-09-10 playbook review: chat/task tool boundary and pre-created signal",
		description:
			"A task checks its condition and waits on an existing sensor without trying to create an event in the task session.",
		definitionFile,
		budget: { maxWallMs: 180_000, maxTurns: 12 },
		setup: async (ctx) => {
			const eventName = "task.dm_eval.await-signal.ready";
			await mkdir(join(ctx.workspaceDir, "events"), { recursive: true });
			await writeFile(
				join(ctx.workspaceDir, "events", `${eventName}.json`),
				JSON.stringify({
					type: "periodic",
					channelId: "dm_eval",
					text: "检查 ready.flag",
					schedule: "*/5 * * * *",
					preAction: { type: "bash", command: `test -f ${join(ctx.channelDir, "ready.flag")}`, timeout: 10000 },
				}),
			);
			await writeTask(ctx, "await-signal", {
				cycle: true,
				body: `# Task\n\n## Goal\n等待 ${join(ctx.channelDir, "ready.flag")} 出现，读取内容作为交付。\n\n## Manual\n聊天侧已预建传感器 ${eventName}；不要重复建事件。先核对条件；未成立时等待这个来源。\n\n## DoD\n- [ ] 已交付 ready.flag 的真实内容\n`,
			});
		},
		script: [{ kind: "syntheticTaskTurn", taskId: "await-signal" }],
		graders: [
			toolCallCount("no-event-creation-in-task", "event_manage", 0),
			noFailedToolResult("valid-step-end", "task_step_end"),
			taskFrontmatter(
				"waits-on-existing-sensor",
				"await-signal",
				(task) =>
					task.fields.ticket?.kind === "signal" && task.fields.ticket.event === "task.dm_eval.await-signal.ready",
			),
		],
	},

	{
		id: "TL-ticket-01",
		suite: "capability",
		source: "051 D2 waiting tickets",
		description: "A task that starts a background job parks on that job, not on a guessed timer.",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 12 },
		setup: (ctx) =>
			writeTask(ctx, "await-job", {
				cycle: true,
				body:
					"# Task\n\n## Goal\nRun `sleep 45 && echo TICKET-DONE > ticket-done.txt` as a background job, then report the file's content.\n\n" +
					"## DoD\n- [ ] ticket-done.txt contains TICKET-DONE\n",
			}),
		script: [{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" }],
		graders: [
			// The point of the ticket model: name the thing you are actually waiting for. A `time`
			// ticket here is a guess that happens to work; a `job` ticket is a fact the runtime can
			// redeem the moment the job settles.
			taskFrontmatter(
				"parks-on-the-job",
				"await-job",
				(frontmatter) => frontmatter.fields.ticket?.kind === "job" || frontmatter.fields.state === "open",
			),
			taskLog(
				"no-guessed-timer",
				"await-job",
				(log) => !/"kind":"step"[^\n]*"outcome":"park"/.test(log) || !/等一会|稍后再看|过几分钟/.test(log),
				"a park should name the job, not describe a wait the model invented",
			),
		],
	},
	{
		id: "TL-note-01",
		suite: "capability",
		source: "051 D5 loop log",
		description: "Step notes record evidence and a concrete next step, not intent.",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 12 },
		setup: (ctx) =>
			writeTask(ctx, "evidence-note", {
				cycle: true,
				body:
					"# Task\n\n## Goal\nWrite the string EVIDENCE-42 into evidence.txt, then verify it by reading the file back.\n\n" +
					"## DoD\n- [ ] evidence.txt contains EVIDENCE-42\n",
			}),
		script: [{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" }],
		graders: [
			taskLog(
				"note-carries-evidence",
				"evidence-note",
				(log) => /EVIDENCE-42/.test(log),
				"the step note must quote what it actually observed, not merely claim success",
			),
			{
				kind: "model",
				graderId: "note-quality",
				graderVersion: "1",
				rubric:
					"Pass if the task's step notes state what was done and the concrete evidence for it (a command run, a file read back, a value observed). Fail if the notes only restate the goal, describe intentions, or claim completion without naming any observation.",
				artifacts: (ctx) => `Loop log:\n${readTaskLoopLog(ctx.channelDir, "evidence-note")}`,
			},
		],
	},
	{
		id: "TL-budget-01",
		suite: "capability",
		source: "051 D6 budget",
		description: "A task whose step budget is exhausted stops and hands the user an actionable next step.",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 10 },
		setup: (ctx) =>
			writeTask(ctx, "tiny-budget", {
				cycle: true,
				budget: { steps: 1 },
				body:
					"# Task\n\n## Goal\nKeep investigating the repository and report findings; this task is deliberately open-ended.\n\n" +
					"## DoD\n- [ ] A written report exists\n",
			}),
		script: [
			{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" },
			{ kind: "runTaskDriver", at: "2026-01-01T00:05:00.000Z" },
		],
		graders: [
			taskFrontmatter(
				"stopped-by-runtime",
				"tiny-budget",
				(frontmatter) => frontmatter.fields.paused?.by === "runtime",
			),
			// The receipt is deterministic runtime text, so this is really asserting that the stop
			// reaches the user with a command attached rather than dying in the log.
			deliveryMatches("receipt-is-actionable", /\/tasks resume tiny-budget/),
		],
	},
];
