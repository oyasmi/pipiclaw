import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	codeGrader,
	deliveryMatches,
	fileContains,
	fileNotContains,
	lastDeliveryMatches,
	recallQuiz,
	taskFrontmatter,
	tracePredicate,
} from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { copyFixture, seedChannelHistory, seedChannelMemory, wakeBody, writeTask } from "./helpers.js";

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
					"Advance a few items at a time, checkpoint with task_manage progress between batches, and do not " +
					"mark done until all 12 lines are present in report.md.\n\n" +
					"## DoD\n" +
					"- [ ] report.md contains ITEM-01 through ITEM-12 in order\n" +
					"- [ ] Item 7's line uses the current data (RECOVERED-7), not the retired ledger\n",
				control: { budget: { maxAttempts: 24 } },
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
	{
		id: "M-recall-04",
		suite: "capability",
		source:
			"2026-07-31 long-horizon-autonomy review, item 0.2; redesigned 2026-08-01 after the first real run scored " +
			"0 tool calls and 10/10 on both trials — the fixture's current values lived in MEMORY.md, which " +
			"`buildFirstTurnMemoryBootstrap` (src/memory/bootstrap.ts) injects into turn one whenever it fits under " +
			"400 units/3000 chars, so the model answered from context instead of retrieving anything.",
		description:
			"After a real maintenance pass over a synthetic 30-day corpus of company operating knowledge (10 facts; " +
			"neither a fact's current value nor its superseded predecessor is ever promoted to MEMORY.md — both live " +
			"only in HISTORY.md, the current one in a recent Update block, the old one in the always-candidate " +
			"Folded block, competing on the same keywords), 10 differently-worded questions are asked back to back. " +
			"Because nothing here is bootstrap-visible, every answer has to come from a real turn-time recall. " +
			"Scores recall (did the current value come back) and precision (did an honest miss avoid answering " +
			"with the superseded value instead).",
		definitionFile,
		fixtures: ["memory/company-30d-memory.md", "memory/company-30d-history.md"],
		budget: { maxWallMs: 400_000, maxTurns: 40 },
		setup: async (ctx) => {
			await seedChannelMemory(
				ctx,
				readFileSync(join(process.cwd(), "evals/fixtures/memory/company-30d-memory.md"), "utf8"),
			);
			await seedChannelHistory(
				ctx,
				readFileSync(join(process.cwd(), "evals/fixtures/memory/company-30d-history.md"), "utf8"),
			);
		},
		script: [
			{ kind: "runMemoryMaintenance" },
			{ kind: "user", text: "报销单据现在应该找谁签字？只回答姓名和括号里的代号。" },
			{ kind: "user", text: "我们新建微服务仓库时，仓库名前缀应该用什么？只回答前缀本身。" },
			{ kind: "user", text: "Acme 客户那边现在对接的联系人是谁？只回答代号。" },
			{ kind: "user", text: "现在团队的知识库工具用的是哪个？只回答产品名。" },
			{ kind: "user", text: "值班时收到告警走的是什么渠道？只回答代号。" },
			{ kind: "user", text: "数据库迁移一般安排在什么时候？只回答代号。" },
			{ kind: "user", text: "现在用的财务系统内部代号是什么？只回答代号。" },
			{ kind: "user", text: "新同事入职的带教负责人现在是谁？只回答代号。" },
			{ kind: "user", text: "灰度发布现在的默认流量比例代号是什么？只回答代号。" },
			{ kind: "user", text: "发现安全事件应该往哪上报？只回答代号。" },
		],
		graders: [
			recallQuiz(
				"company-knowledge-recall",
				[
					{ expected: /CHENHAO/i, distractor: /WANGFANG/i },
					{ expected: /px-/i, distractor: /svc-/i },
					{ expected: /ZHAOQIANG-ACME/i, distractor: /LINA-ACME/i },
					{ expected: /Notion/i, distractor: /Confluence/i },
					{ expected: /DINGTALK-SMS/i, distractor: /EMAIL-ONLY/i },
					{ expected: /SATURDAY-10AM/i, distractor: /TUESDAY-2AM/i },
					{ expected: /FIN-NOVA-7/i, distractor: /FIN-LEGACY-3/i },
					{ expected: /SUNYUE/i, distractor: /LIUYANG/i },
					{ expected: /CANARY-RATIO-20/i, distractor: /CANARY-RATIO-5/i },
					{ expected: /SEC-TICKET-SYS/i, distractor: /SEC-MAILBOX/i },
				],
				{ minRecall: 0.7, minPrecision: 0.9 },
			),
		],
	},
];
