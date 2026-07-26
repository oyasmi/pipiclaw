import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryMatches, fileContains } from "../harness/graders.js";
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
			"A paraphrased query with no key lexical overlap retrieves the seeded concept (expected partial failure).",
		definitionFile,
		fixtures: ["memory/semantic.md"],
		setup: async (ctx) =>
			seedChannelMemory(ctx, readFileSync(join(process.cwd(), "evals/fixtures/memory/semantic.md"), "utf8")),
		script: [
			{
				kind: "user",
				text: "Which saved transport choice avoids connection-level head-of-line blocking while still being encrypted? Answer only with its name.",
			},
		],
		graders: [deliveryMatches("semantic-answer", /QUIC/i)],
	},
	{
		id: "C-research-01",
		suite: "capability",
		source: "028 model-grader pilot",
		description: "A local-document research answer is faithful enough for an independent model judge.",
		definitionFile,
		fixtures: ["research/runtime.md"],
		setup: (ctx) => copyFixture(ctx, "research/runtime.md", "dm_eval/research/runtime.md"),
		script: [
			{
				kind: "user",
				text: "Read research/runtime.md and summarize the runtime's transport priority, memory layers, and how scheduled task dispatch is governed. Do not add facts outside the document.",
			},
		],
		graders: [
			{
				kind: "model",
				graderId: "research-faithfulness",
				graderVersion: "1",
				rubric:
					"Pass only if the answer states that DingTalk is the primary transport, distinguishes session and durable memory, and says scheduled task dispatch passes deterministic deadline/budget/dependency governance before model work. Fail for unsupported claims or reversal of any of those facts. Score from 0 to 1.",
				artifacts: (ctx) =>
					ctx.deliveries
						.map((delivery) => delivery.text)
						.filter(Boolean)
						.join("\n"),
			},
		],
	},
];
