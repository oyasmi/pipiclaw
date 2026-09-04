import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	codeGrader,
	deliveryMatches,
	fileContains,
	fileNotContains,
	taskFrontmatter,
	tracePredicate,
} from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { copyFixture, wakeBody, writeTask } from "./helpers.js";

const definitionFile = "evals/cases/capability.ts";

/** `k`-th tick of a virtual TaskDriver schedule spaced past `continuationDelayMinutes` (5m default). */
const driverTick = (k: number): string =>
	new Date(Date.parse("2026-01-01T00:00:00.000Z") + k * 10 * 60_000).toISOString();

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
			taskFrontmatter("release-still-open", "resume-ten", (frontmatter) => frontmatter.archiveOutcome === undefined),
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
	// M-recall-02 (semantic recall probe) and M-recall-04 (30-day corpus, HISTORY.md-hidden
	// facts) retired 2026-09-04 (spec 050): both tested the v1 lexical/rerank recall pipeline's
	// specific gap-filling behavior — "a fact not injected into the turn must still be found by
	// real-time recall". That mechanism no longer exists (D1: the index is injected whole on the
	// first turn, or tiered by D4's budget rules; nothing is fetched per-turn by relevance). The
	// same intent — can the model find a fact the first-turn injection omitted? — is covered more
	// rigorously by `evals/memory-recall-quality/` (30 seeded memories, 20 paraphrased questions,
	// scored against a real budget-tiered index).
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
			deliveryMatches("current-memory-layers", /journal[\s\S]*memory|memory[\s\S]*journal/i),
			deliveryMatches(
				"incident-stopped-before-model",
				/RC-17[\s\S]{0,500}(?:pause|stop|must not|not be sent)[\s\S]{0,200}(?:model|模型)|(?:pause|stop)[\s\S]{0,200}RC-17/i,
			),
			{
				kind: "model",
				graderId: "research-faithfulness",
				graderVersion: "2",
				rubric:
					"Pass only if the answer (1) identifies runtime.md as current and legacy.md as superseded, (2) says DingTalk is the current primary transport, (3) distinguishes the journal (day-by-day working record) from durable memory, and (4) concludes that incident task RC-17 must be paused before model work because its attempt budget is exhausted (the expired deadline independently blocks it). Fail if Slack, flat transcript memory, or direct-to-model dispatch is presented as current, if current and legacy claims are blended without provenance, or if the task is said to run. Score from 0 to 1.",
				artifacts: (ctx) =>
					ctx.deliveries
						.map((delivery) => delivery.text)
						.filter(Boolean)
						.join("\n"),
			},
		],
	},
	{
		id: "T-chain-recover-01",
		suite: "capability",
		source:
			"2026-07-31 long-horizon-autonomy review, item 0.1; renamed 2026-08-01 after the first real run showed " +
			"`accepted-dispatch-count` at 1/16 on both trials — glm-5-turbo resolved the whole 12-item chain, dead " +
			"end included, inside its first dispatched turn. Nothing in this runtime caps tool calls per TaskDriver " +
			"turn, so a 12-item bounded chain does not force the multi-wake spanning the original name (T-long-01) " +
			"claimed. That capability — genuine cross-wake continuation under a governed loop — is still untested " +
			"and would need a script step that can reveal new state partway through (not just at setup), which " +
			"this suite does not have yet.",
		description:
			"A 12-item chained-lookup task, dispatched through a real TaskDriver tick, with one item's data retired " +
			"mid-chain to a superseded pointer. Measures whether a single governed turn resolves the dead end and " +
			"records the detour (not just guesses around it) rather than whether the governor misfires — plus " +
			"whatever cost/turns/dispatch-count the report surfaces for free. `budget.maxAttempts` is overridden to " +
			"24 so a slower model that does need more than one wake is not cut off by the known 12-attempt lifetime " +
			"cap (leverage-and-experience-review-r2 E-8); drop the override once that cap becomes a rolling window.",
		definitionFile,
		budget: { maxWallMs: 600_000, maxTurns: 90, maxSteps: 40, maxCostUsd: 3 },
		trials: 2,
		setup: async (ctx) => {
			const sourcesDir = join(ctx.channelDir, "sources");
			await mkdir(sourcesDir, { recursive: true });
			for (let index = 1; index <= 12; index++) {
				const id = String(index).padStart(2, "0");
				if (index === 7) {
					await writeFile(
						join(sourcesDir, "item-07.txt"),
						"This item's data now lives in sources/ledger-a.txt.\n",
					);
					continue;
				}
				await writeFile(join(sourcesDir, `item-${id}.txt`), `ITEM-${id} token: TOK-${id}\n`);
			}
			await writeFile(
				join(sourcesDir, "ledger-a.txt"),
				"RETIRED: this ledger was superseded on 2025-11-01. Use sources/ledger-b.txt instead.\n",
			);
			await writeFile(join(sourcesDir, "ledger-b.txt"), "ITEM-07 token: RECOVERED-7\n");
			await writeTask(ctx, "long-run", {
				body:
					"# Task\n\n" +
					"## Goal\n" +
					"Process items 1 through 12 under sources/, in order. For each item NN, read sources/item-NN.txt " +
					"and find a line of the form 'ITEM-NN token: TOKEN'. Append a line 'ITEM-NN: TOKEN' to report.md " +
					"(create it if missing), in increasing NN order, never duplicating a line already present.\n\n" +
					"If an item's file points to another file instead of containing a token directly, follow the " +
					"pointer. If a pointed-to file says it is retired or superseded, do not use its content as the " +
					"token; follow its instruction to the next file instead. Record in this task's Current Cycle which " +
					"item required a redirect and what the redirect said, so the reason survives a future wake.\n\n" +
					"Advance a few items at a time, checkpoint with task_update (note set) between batches, and do not " +
					"mark done until all 12 lines are present in report.md.\n\n" +
					"## DoD\n" +
					"- [ ] report.md contains ITEM-01 through ITEM-12 in order\n" +
					"- [ ] Item 7's line uses the current data (RECOVERED-7), not the retired ledger\n",
			});
		},
		script: Array.from({ length: 16 }, (_, index) => ({ kind: "runTaskDriver", at: driverTick(index) }) as const),
		graders: [
			// `runWorkerSegment` already appends a `production-driver-dispatch` grade whenever the
			// script contains a `runTaskDriver` step (evals/harness/run.ts), so "driven by the real
			// driver, at least once" needs no grader of its own here. This one is deliberately
			// always-pass: how many of the 16 scheduled ticks the driver actually accepted before the
			// task finished, stalled, or was paused is exactly the "how many wakes did this take"
			// datum the 0.1 review item asks the eval to surface — it should show up in every report,
			// not gate the trial on a specific count that a fast, correct completion would undercut.
			codeGrader("accepted-dispatch-count", (ctx) => {
				const accepted = ctx.trace.filter((event) => event.fields?.driverDispatch === "true" && event.ok).length;
				return {
					schemaVersion: 1,
					graderId: "accepted-dispatch-count",
					graderVersion: "1",
					graderKind: "code",
					status: "pass",
					severity: "quality",
					evidence: [{ kind: "trace", ref: "trace.jsonl" }],
					rationale: `${accepted}/16 scheduled TaskDriver ticks were accepted and dispatched before the trial ended`,
				};
			}),
			fileContains(
				"all-items-completed-in-order",
				"report.md",
				/ITEM-01[\s\S]*ITEM-02[\s\S]*ITEM-03[\s\S]*ITEM-04[\s\S]*ITEM-05[\s\S]*ITEM-06[\s\S]*ITEM-07[\s\S]*ITEM-08[\s\S]*ITEM-09[\s\S]*ITEM-10[\s\S]*ITEM-11[\s\S]*ITEM-12/,
			),
			fileContains("dead-end-resolved", "report.md", /ITEM-07:\s*RECOVERED-7/),
			fileNotContains("dead-end-not-guessed", "report.md", /RETIRED/),
			taskFrontmatter(
				"not-misfired-by-governor",
				"long-run",
				(frontmatter) =>
					!(
						frontmatter.status === "active" &&
						frontmatter.enabled === false &&
						frontmatter.control?.stop?.by === "governor"
					),
			),
			taskFrontmatter(
				"detour-recorded",
				"long-run",
				(frontmatter, content) => frontmatter.readable && /ledger-a|RETIRED|redirect/i.test(content),
			),
		],
	},
];
