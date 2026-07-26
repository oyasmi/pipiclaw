import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	deliveryMatches,
	fileContains,
	lastDeliveryMatches,
	taskFrontmatter,
	tracePredicate,
} from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { copyFixture, seedChannelMemory, wakeBody, writeTask } from "./helpers.js";

const definitionFile = "evals/cases/capability.ts";

export const capabilityCases: EvalCase[] = [
	{
		id: "T-resume-10",
		suite: "capability",
		source: "028 long-task upper-bound probe",
		description: "Ten simulated wakes preserve a task's goal and unmet release condition.",
		definitionFile,
		budget: { maxTurns: 14, maxWallMs: 300_000 },
		setup: (ctx) => writeTask(ctx, "resume-ten", { body: wakeBody("GAMMA-10", "RELEASE-GAMMA") }),
		script: Array.from({ length: 10 }, () => ({ kind: "syntheticTaskTurn", taskId: "resume-ten" }) as const),
		graders: [
			fileContains("goal-and-dod-retained", "tasks/resume-ten.md", /GAMMA-10[\s\S]*RELEASE-GAMMA/),
			tracePredicate(
				"read-on-every-wake",
				(ctx) =>
					ctx.trace.filter(
						(event) =>
							event.kind === "tool-call" &&
							event.tool === "read" &&
							/resume-ten\.md/.test(event.fields?.path ?? event.fields?.file_path ?? ""),
					).length >= 10,
				"all ten wakes must re-read the durable task; passive prompt carry-over is not recovery",
			),
			taskFrontmatter("release-still-open", "resume-ten", (frontmatter) => frontmatter.status !== "done"),
			{
				kind: "model",
				graderId: "ten-wake-loyalty",
				graderVersion: "1",
				rubric:
					"Pass if the final task and outward updates remain loyal to goal token GAMMA-10 after ten wakeups and preserve RELEASE-GAMMA as the unmet completion condition. Silence and repeated checkpointing are allowed. Fail for goal drift or false completion.",
				artifacts: (ctx) => {
					const path = join(ctx.channelDir, "tasks", "resume-ten.md");
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
		id: "T-crash-01",
		suite: "capability",
		source: "028 process crash recovery",
		description:
			"A real SIGKILL after a production driver turn preserves a durable checkpoint for cold-start inspection.",
		definitionFile,
		// This probe intentionally spans boundary-crash recovery and a mid-turn crash;
		// allow its expected multi-turn protocol while retaining the wall hard stop.
		budget: { maxWallMs: 240_000, maxTurns: 18 },
		setup: (ctx) =>
			writeTask(ctx, "crash-task", {
				body: "# Task\n\n## Goal\nWrite crash-checkpoint.txt containing DURABLE-CHECKPOINT, then record progress but do not close the task.\n\n## DoD\n- [ ] User supplies CLOSE-CRASH\n",
				wake: "2020-01-01T00:00:00.000Z",
			}),
		script: [
			{ kind: "runTaskDriver", at: "2026-01-01T00:00:00.000Z" },
			{ kind: "crash", mode: "atStepBoundary" },
			{
				kind: "user",
				text: "After the crash, read {{CHANNEL_DIR}}/crash-checkpoint.txt. If DURABLE-CHECKPOINT is present, report RECOVERY-CONFIRMED without rewriting the checkpoint.",
			},
			{
				kind: "user",
				text: "Begin a new turn by reading {{CHANNEL_DIR}}/crash-checkpoint.txt and then preparing to append MIDTURN-PROBE, but do not remove DURABLE-CHECKPOINT.",
			},
			{ kind: "crash", mode: "midTurn", delayMs: 250 },
			{
				kind: "user",
				text: "The previous turn was killed mid-turn. Inspect {{CHANNEL_DIR}}/crash-checkpoint.txt and report MIDTURN-RECOVERED while preserving DURABLE-CHECKPOINT, regardless of whether MIDTURN-PROBE reached disk.",
			},
		],
		graders: [
			fileContains("checkpoint-survived", "crash-checkpoint.txt", /DURABLE-CHECKPOINT/),
			deliveryMatches("cold-recovery", /RECOVERY-CONFIRMED/),
		],
	},
	{
		id: "M-recall-02",
		suite: "capability",
		source: "P1-3 semantic recall probe",
		description:
			"A paraphrased query with no key lexical overlap retrieves an arbitrary saved codename that cannot be guessed from world knowledge (expected partial failure).",
		definitionFile,
		fixtures: ["memory/semantic.md"],
		setup: async (ctx) =>
			seedChannelMemory(ctx, readFileSync(join(process.cwd(), "evals/fixtures/memory/semantic.md"), "utf8")),
		script: [
			{
				kind: "user",
				text: "What internal codename did we save for the protocol where one stream's packet loss does not pause its siblings and traffic remains confidential? Answer only with the codename.",
			},
		],
		graders: [lastDeliveryMatches("semantic-answer", /^\s*SKYBRIDGE-9[。.!]?\s*$/i)],
	},
	{
		id: "C-research-01",
		suite: "capability",
		source: "028 model-grader pilot",
		description:
			"A multi-document operator brief resolves an explicitly superseded design, applies current governance to an incident, and avoids treating historical notes as current truth.",
		definitionFile,
		fixtures: ["research/runtime.md", "research/legacy.md", "research/incident.md"],
		setup: async (ctx) => {
			await copyFixture(ctx, "research/runtime.md", "dm_eval/research/runtime.md");
			await copyFixture(ctx, "research/legacy.md", "dm_eval/research/legacy.md");
			await copyFixture(ctx, "research/incident.md", "dm_eval/research/incident.md");
		},
		script: [
			{
				kind: "user",
				text: "Read every file under research/. Write a concise operator brief that distinguishes current behavior from superseded behavior and answers the incident's dispatch question. Use only those files; call out conflicts instead of silently blending them.",
			},
		],
		graders: [
			tracePredicate(
				"all-research-sources-read",
				(ctx) => {
					const paths = ctx.trace
						.filter((event) => event.kind === "tool-call" && event.tool === "read")
						.map((event) => event.fields?.path ?? event.fields?.file_path ?? "");
					return ["incident.md", "legacy.md", "runtime.md"].every((name) =>
						paths.some((path) => path.endsWith(`/research/${name}`)),
					);
				},
				"the brief must be based on all three declared research sources",
			),
			deliveryMatches("current-memory-layers", /SESSION\.md[\s\S]*MEMORY\.md|MEMORY\.md[\s\S]*SESSION\.md/i),
			deliveryMatches(
				"incident-stopped-before-model",
				/RC-17[\s\S]{0,500}(?:pause|stop|must not|not be sent)[\s\S]{0,200}(?:model|模型)|(?:pause|stop)[\s\S]{0,200}RC-17/i,
			),
			{
				kind: "model",
				graderId: "research-faithfulness",
				graderVersion: "2",
				rubric:
					"Pass only if the answer (1) identifies runtime.md as current and legacy.md as superseded, (2) says DingTalk is the current primary transport, (3) distinguishes SESSION.md working state from durable MEMORY.md, and (4) concludes that incident task RC-17 must be paused before model work because its attempt budget is exhausted (the expired deadline independently blocks it). Fail if Slack, flat transcript memory, or direct-to-model dispatch is presented as current, if current and legacy claims are blended without provenance, or if the task is said to run. Score from 0 to 1.",
				artifacts: (ctx) =>
					ctx.deliveries
						.map((delivery) => delivery.text)
						.filter(Boolean)
						.join("\n"),
			},
		],
	},
];
