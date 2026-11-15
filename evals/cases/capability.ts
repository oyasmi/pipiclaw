import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toolObservations } from "../graders/observations.js";
import { researchDecision } from "../graders/research.js";
import { fileContains, tracePredicate } from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { copyFixture } from "./helpers.js";

const definitionFile = "evals/cases/capability.ts";

export const capabilityCases: EvalCase[] = [
	{
		id: "C-research-01",
		suite: "capability",
		source: "028 model-grader pilot",
		description:
			"A multi-document operator brief resolves an explicitly superseded design, applies current governance to an incident, and avoids treating historical notes as current truth.",
		definitionFile,
		fixtures: ["research/runtime.md", "research/legacy.md", "research/incident.md"],
		setup: async (ctx) => {
			await copyFixture(ctx, "research/runtime.md", "desk-eval/research/runtime.md");
			await copyFixture(ctx, "research/legacy.md", "desk-eval/research/legacy.md");
			await copyFixture(ctx, "research/incident.md", "desk-eval/research/incident.md");
		},
		script: [
			{
				kind: "user",
				text: "Read every file under {{DESK_DIR}}/research/. Write a concise operator brief to {{DESK_DIR}}/operator-brief.md distinguishing current and superseded behavior and answering the incident dispatch question. Use only those files. Also save {{DESK_DIR}}/operator-decision.json with keys currentSource, supersededSource, primaryTransport, memoryLayers (choose from daily-journal, durable-facts, flat-transcript), and incident {id, dispatch:boolean, blockers:string[] (choose from attempt-budget, deadline)}. Determine the values from the documents; do not blend superseded claims into current behavior.",
			},
		],
		graders: [
			tracePredicate(
				"all-research-sources-read",
				(ctx) => {
					const read = toolObservations(ctx).filter(({ result }) => result.ok === true);
					return ["incident.md", "legacy.md", "runtime.md"].every((name) =>
						read.some(
							({ call, result }) =>
								(call.tool === "read" &&
									(call.fields?.path ?? call.fields?.file_path ?? "").endsWith(`/research/${name}`)) ||
								(call.tool === "bash" &&
									(call.fields?.command ?? "").includes("research/") &&
									(result.fields?.detail ?? "").includes(name)),
						),
					);
				},
				"all three source documents must be successfully observed",
			),
			researchDecision(),
			fileContains("operator-brief-written", "operator-brief.md", /\S/),
			{
				kind: "model",
				advisory: true,
				graderId: "research-faithfulness",
				graderVersion: "3",
				rubric:
					"Pass only if the answer (1) identifies runtime.md as current and legacy.md as superseded, (2) says DingTalk is the current primary transport, (3) distinguishes the journal (day-by-day working record) from durable memory, and (4) concludes that incident task RC-17 must be paused before model work because its attempt budget is exhausted (the expired deadline independently blocks it). Fail if Slack, flat transcript memory, or direct-to-model dispatch is presented as current, if current and legacy claims are blended without provenance, or if the task is said to run. Score from 0 to 1.",
				artifacts: (ctx) => {
					const artifact = (name: string) => {
						const path = join(ctx.deskDir, name);
						return existsSync(path) ? readFileSync(path, "utf8") : "[missing]";
					};
					return `User-visible delivery:\n${ctx.deliveries.map((delivery) => delivery.text ?? "").join("\n")}\nDelivered brief (operator-brief.md):\n${artifact("operator-brief.md")}\nStructured decision:\n${artifact("operator-decision.json")}`;
				},
			},
		],
	},
];
