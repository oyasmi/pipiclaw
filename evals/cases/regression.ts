import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	codeGrader,
	deliveryMatches,
	deliveryNotMatches,
	driverDispatchCount,
	fileContains,
	taskFrontmatter,
	tracePredicate,
} from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { seedChannelMemory, wakeBody, writeTask } from "./helpers.js";

const definitionFile = "evals/cases/regression.ts";

export const regressionCases: EvalCase[] = [
	{
		id: "T-create-01",
		suite: "regression",
		source: "e2e tasks-lifecycle",
		description: "Natural language creates a governed, parseable task with a real checkbox DoD.",
		definitionFile,
		script: [
			{
				kind: "user",
				text: "Create task eval-create with task_manage. Goal: eventually write hello.txt containing hello. DoD must be one real unchecked checkbox. Use evidence verification and do not start the work yet.",
			},
		],
		graders: [
			taskFrontmatter(
				"governed-task",
				"eval-create",
				(frontmatter, content) =>
					Boolean(frontmatter.control) && /-\s+\[ \]/.test(content) && /hello\.txt/i.test(content),
			),
		],
	},
	{
		id: "T-create-02",
		suite: "regression",
		source: "028 first-wave matrix",
		description: "A broad release goal becomes concrete dependent task records, not a prose-only plan.",
		definitionFile,
		script: [
			{
				kind: "user",
				text: "Create two persistent tasks for a release: release-build produces the package, then release-publish depends on release-build. Do not execute them. Use task_manage and real checkbox DoDs.",
			},
		],
		graders: [
			taskFrontmatter(
				"build-task",
				"release-build",
				(frontmatter, content) => Boolean(frontmatter.control) && /-\s+\[ \]/.test(content),
			),
			taskFrontmatter(
				"publish-dependency",
				"release-publish",
				(frontmatter) => frontmatter.control?.dependsOn.includes("release-build") === true,
			),
		],
	},
	{
		id: "T-resume-01",
		suite: "regression",
		source: "026 §11.2",
		description: "A production-sourced synthetic wake reads the named task before changing it.",
		definitionFile,
		setup: (ctx) => writeTask(ctx, "resume-one", { body: wakeBody("ALPHA-42") }),
		script: [{ kind: "syntheticTaskTurn", taskId: "resume-one" }],
		graders: [
			fileContains("goal-kept", "tasks/resume-one.md", /ALPHA-42/),
			tracePredicate(
				"task-read-first",
				(ctx) => {
					const calls = ctx.trace.filter((event) => event.kind === "tool-call");
					const taskRead = calls.findIndex(
						(event) =>
							event.tool === "read" &&
							/resume-one\.md/.test(event.fields?.path ?? event.fields?.file_path ?? ""),
					);
					const mutation = calls.findIndex(
						(event) => event.tool === "task_manage" || event.tool === "write" || event.tool === "edit",
					);
					return taskRead >= 0 && (mutation < 0 || taskRead < mutation);
				},
				"the named task file must be read before the first task mutation",
			),
		],
	},
	{
		id: "T-resume-03",
		suite: "regression",
		source: "028 long-task goal retention",
		description:
			"Three simulated wakes preserve the original Goal/DoD; this measures recovery count, not wall-clock duration.",
		definitionFile,
		setup: (ctx) => writeTask(ctx, "resume-three", { body: wakeBody("BETA-17", "RELEASE-BETA") }),
		script: [
			{ kind: "syntheticTaskTurn", taskId: "resume-three" },
			{ kind: "syntheticTaskTurn", taskId: "resume-three" },
			{ kind: "syntheticTaskTurn", taskId: "resume-three" },
		],
		graders: [
			fileContains("goal-not-drifted", "tasks/resume-three.md", /BETA-17[\s\S]*RELEASE-BETA/),
			{
				kind: "model",
				graderId: "three-wake-loyalty",
				graderVersion: "1",
				rubric:
					"Pass if the final task and outward updates remain loyal to goal token BETA-17 and keep RELEASE-BETA as the unmet completion condition. Silence or concise checkpoint updates are allowed. Fail if the goal changes, the release condition is removed, or completion is falsely claimed.",
				artifacts: (ctx) => {
					const path = join(ctx.channelDir, "tasks", "resume-three.md");
					const task = existsSync(path) ? readFileSync(path, "utf8") : "(task missing)";
					return `Final task:\n${task}\n\nDeliveries:\n${ctx.deliveries
						.map((delivery) => delivery.text)
						.filter(Boolean)
						.join("\n")}`;
				},
			},
		],
	},
	{
		id: "T-restart-01",
		suite: "regression",
		source: "028 graceful restart",
		description: "A graceful process restart preserves a completed checkpoint and avoids repeating it.",
		definitionFile,
		script: [
			{ kind: "user", text: "Write {{WORKSPACE_DIR}}/checkpoint.txt with exactly PHASE-ONE." },
			{ kind: "restart" },
			{
				kind: "user",
				text: "Read {{WORKSPACE_DIR}}/checkpoint.txt first. If PHASE-ONE already exists, append a new line PHASE-TWO to that exact file without duplicating PHASE-ONE.",
			},
		],
		graders: [
			codeGrader("checkpoint-once", (ctx) => {
				const path = join(ctx.workspaceDir, "checkpoint.txt");
				const content = existsSync(path) ? readFileSync(path, "utf8") : "";
				const pass = (content.match(/PHASE-ONE/g) ?? []).length === 1 && /PHASE-TWO/.test(content);
				return {
					schemaVersion: 1,
					graderId: "checkpoint-once",
					graderVersion: "1",
					status: pass ? "pass" : "fail",
					severity: "quality",
					evidence: [{ kind: "file", ref: "checkpoint.txt" }],
					rationale: "checkpoint must contain each completed phase exactly once",
				};
			}),
		],
	},
	{
		id: "T-blocked-01",
		suite: "regression",
		source: "028 explicit state",
		description: "A missing external prerequisite becomes a persisted blocked task, never fabricated completion.",
		definitionFile,
		script: [
			{
				kind: "user",
				text: "Create task blocked-release. It cannot proceed because RELEASE_SIGNING_TOKEN is absent. Persist the correct lifecycle state and reason; do not claim completion.",
			},
		],
		graders: [
			taskFrontmatter(
				"blocked-state",
				"blocked-release",
				(frontmatter) =>
					frontmatter.control?.lastOutcome === "blocked" &&
					/RELEASE_SIGNING_TOKEN/i.test(frontmatter.control.blockedReason ?? ""),
			),
			deliveryNotMatches("no-false-success", /completed|successfully released/i),
		],
	},
	{
		id: "T-deadline-01",
		suite: "regression",
		source: "028 production driver governance",
		description: "The real TaskDriver governance pass escalates an expired task before model implementation.",
		definitionFile,
		setup: (ctx) =>
			writeTask(ctx, "expired-task", {
				body: wakeBody("DEADLINE-LOCK"),
				wake: "2020-01-01T00:00:00.000Z",
				control: { deadline: "2020-01-02T00:00:00.000Z" },
			}),
		script: [{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" }],
		graders: [
			driverDispatchCount("deadline-dispatch", 1),
			taskFrontmatter(
				"deadline-escalated",
				"expired-task",
				(frontmatter, content) =>
					(frontmatter.status === "escalated" || frontmatter.status === "cancelled") &&
					/DEADLINE-LOCK/.test(content),
			),
		],
	},
	{
		id: "T-recur-01",
		suite: "regression",
		source: "027 recurring task semantics",
		description: "Two scans of one due occurrence use the real driver and do not dispatch that occurrence twice.",
		definitionFile,
		// A cycle-start turn exercises the full task playbook and can legitimately spend longer
		// than the generic three-minute trial cap. Keep a hard cap, but leave enough room for
		// the intended recurrence assertions to run instead of mostly measuring timeout variance.
		budget: { maxWallMs: 300_000, maxTurns: 18 },
		setup: (ctx) =>
			writeTask(ctx, "daily-cycle", {
				status: "done",
				wake: "2025-12-31T00:00:00.000Z",
				schedule: "0 0 * * *",
				body: "# Task\n\n## Goal\nOn cycle start, use task_manage start-cycle, record CYCLE-STARTED, then close this evidence-only cycle.\n\n## DoD\n- [ ] CYCLE-STARTED recorded\n",
			}),
		script: [
			{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" },
			{ kind: "runTaskDriver", at: "2026-01-01T00:00:01.000Z" },
		],
		graders: [
			driverDispatchCount("single-occurrence", 1),
			taskFrontmatter(
				"next-occurrence-scheduled",
				"daily-cycle",
				(frontmatter) =>
					frontmatter.wake !== undefined && Date.parse(frontmatter.wake) > Date.parse("2026-01-01T00:00:01.000Z"),
			),
		],
	},
	{
		id: "M-recall-01",
		suite: "regression",
		source: "028 memory precision",
		description: "Relevant seeded memory is used while lexical distractors are excluded from the answer.",
		definitionFile,
		setup: (ctx) =>
			seedChannelMemory(
				ctx,
				"- [project] The launch color is cobalt.\n- [distractor] The archived logo was amber.\n- [distractor] The test environment uses violet.",
			),
		script: [{ kind: "user", text: "What is the launch color? Answer only with the remembered value." }],
		graders: [deliveryMatches("recalled-cobalt", /cobalt/i), deliveryNotMatches("no-distractor", /amber|violet/i)],
	},
	{
		id: "M-write-01",
		suite: "regression",
		source: "026 §11.2",
		description: "An explicit durable preference is written in the same turn.",
		definitionFile,
		script: [{ kind: "user", text: "Remember for future work that my default implementation language is Rust." }],
		graders: [
			fileContains(
				"durable-memory",
				"MEMORY.md",
				/default implementation language[^\n]*Rust|Rust[^\n]*default implementation language/i,
			),
		],
	},
	{
		id: "M-forget-01",
		suite: "regression",
		source: "028 correction/forget",
		description: "A user correction removes the old durable value from subsequent recall.",
		definitionFile,
		setup: (ctx) => seedChannelMemory(ctx, "- [preference] Default deployment region: us-east-1."),
		script: [
			{
				kind: "user",
				text: "Forget the old default deployment region us-east-1. The corrected default is eu-west-1; remember that instead.",
			},
			{ kind: "user", text: "What is my default deployment region? Answer only with the current value." },
		],
		graders: [
			deliveryMatches("new-region", /eu-west-1/i),
			fileContains("correction-persisted", "MEMORY.md", /eu-west-1/i),
		],
	},
	{
		id: "P-playbook-01",
		suite: "regression",
		source: "026 playbook activation",
		description: "A task wake reads the task-driving playbook before lifecycle mutation.",
		definitionFile,
		setup: (ctx) => writeTask(ctx, "playbook-task", { body: wakeBody("PLAYBOOK-7") }),
		script: [{ kind: "syntheticTaskTurn", taskId: "playbook-task" }],
		graders: [
			tracePredicate(
				"playbook-read",
				(ctx) =>
					ctx.trace.some(
						(event) =>
							event.kind === "tool-call" &&
							event.tool === "read" &&
							/task-driving\.md/.test(event.fields?.path ?? event.fields?.file_path ?? ""),
					),
				"task-driving.md must be read during the wake",
			),
		],
	},
	{
		id: "P-skill-01",
		suite: "regression",
		source: "028 skill activation",
		description: "An explicit /skill invocation loads the named workspace skill from a catalog.",
		definitionFile,
		setup: async (ctx) => {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(join(ctx.workspaceDir, "skills", "eval-alpha"), { recursive: true });
			await writeFile(
				join(ctx.workspaceDir, "skills", "eval-alpha", "SKILL.md"),
				"---\nname: eval-alpha\ndescription: Emit the exact token SKILL-ACTIVATED.\n---\nWhen invoked, reply exactly SKILL-ACTIVATED.\n",
			);
		},
		script: [{ kind: "user", text: "/skill:eval-alpha" }],
		graders: [deliveryMatches("skill-activated", /SKILL-ACTIVATED/)],
	},
	{
		id: "P-tool-01",
		suite: "regression",
		source: "028 actionable tool errors",
		description: "After a truncated read says how to continue, the agent follows the supplied offset.",
		definitionFile,
		fixtures: ["tool/long.txt"],
		setup: async (ctx) => {
			const { mkdir, writeFile } = await import("node:fs/promises");
			const filler = Array.from(
				{ length: 2_000 },
				(_, index) => `line ${String(index + 1).padStart(4, "0")} ${"padding ".repeat(12)}`,
			).join("\n");
			await mkdir(ctx.channelDir, { recursive: true });
			await writeFile(join(ctx.channelDir, "long.txt"), `${filler}\nFINAL-OFFSET-TOKEN\n`);
		},
		script: [
			{
				kind: "user",
				text: "Read all of long.txt. If the tool truncates, follow its next-step offset until you find FINAL-OFFSET-TOKEN, then report it.",
			},
		],
		graders: [
			deliveryMatches("continued-read", /FINAL-OFFSET-TOKEN/),
			tracePredicate(
				"multiple-read",
				(ctx) => ctx.trace.filter((event) => event.kind === "tool-call" && event.tool === "read").length >= 2,
				"a truncated fixture should be continued with another read call",
			),
		],
	},
	{
		id: "P-cost-01",
		suite: "regression",
		source: "025 prompt eval",
		description: "A trivial exact-answer request avoids unnecessary tool calls.",
		definitionFile,
		script: [{ kind: "user", text: "Reply with exactly: eval pong" }],
		graders: [
			deliveryMatches("exact-answer", /^eval pong$/im),
			tracePredicate(
				"no-tools",
				(ctx) => !ctx.trace.some((event) => event.kind === "tool-call"),
				"simple response should not call a tool",
			),
		],
	},
];
