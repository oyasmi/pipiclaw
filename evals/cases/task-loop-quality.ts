import { noteObservedEvidence } from "../graders/task-notes.js";
import { deliveryMatches, driverDispatchCount, readTaskLoopLog, taskFrontmatter } from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { writeTask } from "./helpers.js";

const definitionFile = "evals/cases/task-loop-quality.ts";

/**
 * Spec 051 §10: behavioural probes for step-note evidence quality and actionable budget-stop
 * receipts. Waiting-on-bound-work is covered in core (`T-job-01` and `T-run-01`).
 */
export const taskLoopQualityCases: EvalCase[] = [
	{
		id: "TL-note-01",
		suite: "capability",
		source: "051 D5 loop log",
		description: "Step notes record evidence and a concrete next step, not intent.",
		definitionFile,
		budget: { maxWallMs: 240_000, maxTurns: 12 },
		setup: (ctx) =>
			writeTask(ctx, "evidence-note", {
				started: true,
				body:
					"# Task\n\n## Goal\nWrite the string EVIDENCE-42 into evidence.txt, then verify it by reading the file back.\n\n" +
					"## DoD\n- [ ] evidence.txt contains EVIDENCE-42\n",
			}),
		script: [{ kind: "runTaskLane" }],
		graders: [
			driverDispatchCount("tl-note-01-dispatch", { min: 1 }),
			noteObservedEvidence(),
			{
				kind: "model",
				advisory: true,
				graderId: "note-quality",
				graderVersion: "1",
				rubric:
					"Pass if the task's step notes state what was done and the concrete evidence for it (a command run, a file read back, a value observed). Fail if the notes only restate the goal, describe intentions, or claim completion without naming any observation.",
				artifacts: (ctx) => `Loop log:\n${readTaskLoopLog(ctx.deskDir, "evidence-note")}`,
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
				started: true,
				budget: { steps: 1 },
				body:
					"# Task\n\n## Goal\nKeep investigating the repository and report findings; this task is deliberately open-ended.\n\n" +
					"## DoD\n- [ ] A written report exists\n",
			}),
		script: [{ kind: "runTaskLane" }, { kind: "runTaskLane" }],
		graders: [
			driverDispatchCount("tl-budget-01-dispatch", 1),
			taskFrontmatter(
				"stopped-by-runtime",
				"tiny-budget",
				(frontmatter) => frontmatter.fields.paused?.by === "runtime",
			),
			deliveryMatches("receipt-is-actionable", /\/tasks resume tiny-budget/),
		],
	},
];
