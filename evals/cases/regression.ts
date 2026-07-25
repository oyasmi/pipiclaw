import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	codeGrader,
	deliveryMatches,
	deliveryNotMatches,
	driverDispatchCount,
	fileContains,
	noFailedToolResult,
	taskFrontmatter,
	toolArgumentIntact,
	toolCallCount,
	tracePredicate,
} from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import {
	hasStatus,
	longNonAsciiValue,
	seedChannelMemory,
	wakeBody,
	warmupTurns,
	writeSubAgent,
	writeTask,
} from "./helpers.js";

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
		description: "A broad release goal becomes concrete ordered task records, not a prose-only plan.",
		definitionFile,
		script: [
			{
				kind: "user",
				text: "Create two persistent tasks for a release: release-build produces the package, then release-publish runs after release-build. Do not execute them. Use task_manage and real checkbox DoDs.",
			},
		],
		graders: [
			taskFrontmatter(
				"build-task",
				"release-build",
				(frontmatter, content) => Boolean(frontmatter.control) && /-\s+\[ \]/.test(content),
			),
			// Spec 036 D4 retired the `dependsOn` graph: ordering is now expressed in the task
			// body (Goal/Manual), so that is where the constraint has to show up.
			taskFrontmatter(
				"publish-ordering",
				"release-publish",
				(frontmatter, content) =>
					Boolean(frontmatter.control) && /-\s+\[ \]/.test(content) && /release-build/.test(content),
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
			// `control.lastOutcome` is runtime-owned telemetry that only attempt claim/finish and the
			// governor write (spec 036; `src/tools/task-manage/lifecycle.ts` leaves it untouched by
			// design). A model-driven turn therefore cannot produce `lastOutcome: "blocked"` — the
			// agent-visible way to persist "cannot proceed" is `waiting` plus a blocked reason.
			taskFrontmatter(
				"blocked-state",
				"blocked-release",
				(frontmatter) =>
					hasStatus(frontmatter, "waiting") &&
					/RELEASE_SIGNING_TOKEN/i.test(frontmatter.control?.blockedReason ?? ""),
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
			// Spec 036 D3 retired the `escalated` status: the deterministic governor now writes
			// `paused` + `control.pausedBy: "governor"` (`src/tasks/store.ts` escalateTask), and
			// `parseTaskFrontmatter` canonicalises any legacy value on read — so asserting the old
			// string could never be true again.
			taskFrontmatter(
				"deadline-escalated",
				"expired-task",
				(frontmatter, content) =>
					hasStatus(frontmatter, "paused") &&
					frontmatter.control?.pausedBy === "governor" &&
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
		id: "M-write-03",
		suite: "regression",
		source: "reported 2026-07-24; memory_manage content dropped in transit on long non-ASCII values",
		description:
			"A long non-ASCII durable fact (the transport-prone shape: streamed JSON tail truncation drops the trailing `content` key) is saved in the same turn, in one clean call. Covers both halves of the 2026-07-25 fix: the end state must be right, and the retry path must not have been needed to get there.",
		definitionFile,
		script: [
			{
				kind: "user",
				text: "请用 memory_manage 工具（op=save）把下面这条长期事实记下来，方便以后关键词检索：张三的全部工作项目都放在 ~/projects 目录下，一共五个 git 仓库，分别叫 pipiclaw、frobulator、widgets-api、data-pipeline 和 docs-site，主力语言是 TypeScript，统一部署在阿里云。",
			},
		],
		trials: 3,
		budget: { maxTurns: 8 },
		graders: [
			fileContains("durable-memory-subject", "MEMORY.md", /张三/),
			fileContains("durable-memory-keyword", "MEMORY.md", /pipiclaw/i),
			// The end state alone cannot detect the reported defect: when `content` is dropped in
			// transit the tool rejects the call, the model retries, and MEMORY.md ends up correct
			// anyway. These two make the truncation itself visible — and keep the required gate at
			// 2/3 so an occasional provider-side drop is reported rather than treated as a product
			// regression, while losing the retry path (all three trials) still turns the gate red.
			toolCallCount("single-shot-save", "memory_manage", 1, ["op", /save/]),
			noFailedToolResult("no-dropped-argument", "memory_manage"),
		],
	},
	{
		id: "M-recall-03",
		suite: "regression",
		source: "2026-07-25 review: every memory case was a cold single turn",
		description:
			"A fact stated mid-conversation survives six unrelated turns and one real maintenance pass, then is recalled. Warm-context counterpart of M-recall-01, whose fact is seeded on disk and asked for immediately.",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 20 },
		script: [
			...warmupTurns(2),
			{
				kind: "user",
				text: "顺便说一下，我们这个项目的发布窗口固定在每周四晚上 22:00，代号叫 THURSDAY-GATE。",
			},
			...warmupTurns(2, 2),
			// The scheduler's timer never runs in a trial (`startServices: false`), so the pass that
			// rewrites SESSION.md and folds durable memory has to be driven explicitly.
			{ kind: "runMemoryMaintenance" },
			...warmupTurns(2, 4),
			{ kind: "user", text: "我们的发布窗口代号是什么？只回答代号本身。" },
		],
		graders: [deliveryMatches("warm-recall", /THURSDAY-GATE/i)],
	},
	{
		id: "M-maint-01",
		suite: "regression",
		source: "2026-07-25 review: the memory maintenance pipeline had zero behavior coverage",
		description:
			"One production maintenance pass over a warm channel produces a SESSION.md that reflects the conversation. Drives the real scheduler, not a reimplementation of its job order.",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 16 },
		script: [
			...warmupTurns(3),
			{ kind: "user", text: "记一下：这次排查的根因代号是 ROOTCAUSE-88，先不用写进长期记忆。" },
			{ kind: "runMemoryMaintenance" },
		],
		graders: [
			fileContains("session-written", "SESSION.md", /ROOTCAUSE-88/i),
			// A maintenance pass is not licence to invent durable facts; the checkpoint job has its
			// own confidence bar and this keeps an eye on it.
			deliveryNotMatches("maintenance-is-silent", /SESSION\.md|maintenance/i),
		],
	},
	{
		id: "A-delegate-01",
		suite: "regression",
		source: "2026-07-25 review: specs 032/033/034 reshaped sub-agents with no behavior coverage",
		description:
			"An explicit delegation reaches a workspace sub-agent and its finding comes back to the user. Covers the workspace-only discovery path and the invocation surface.",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 14 },
		setup: async (ctx) => {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(ctx.channelDir, { recursive: true });
			await writeFile(
				join(ctx.channelDir, "inventory.txt"),
				"service: billing\nowner: platform-team\nSECRET-OWNER-TOKEN: OWNER-ALPHA-9\n",
			);
			await writeSubAgent(ctx, "eval-scout", {
				description: "只读查找：在工作区文件中定位一个字段的值并原样返回，不做修改。",
				tools: ["read"],
				body: "你是只读查找子代理。读取任务指定的文件，找出被问到的字段，把它的值原样回报。不要修改任何文件，不要给出解释以外的行动。",
			});
		},
		script: [
			{
				kind: "user",
				text: "用 subagent 工具把这件事委派给名为 eval-scout 的子代理：读取 {{CHANNEL_DIR}}/inventory.txt，找出 SECRET-OWNER-TOKEN 的值。把它返回的值告诉我。",
			},
		],
		graders: [
			tracePredicate(
				"delegated-to-workspace-agent",
				(ctx) =>
					ctx.trace.some(
						(event) =>
							event.kind === "tool-call" && event.tool === "subagent" && event.fields?.agent === "eval-scout",
					),
				"the named workspace sub-agent must actually be invoked",
			),
			deliveryMatches("subagent-finding-returned", /OWNER-ALPHA-9/),
		],
	},
	{
		id: "P-tool-02",
		suite: "regression",
		source: "2026-07-25 review: long non-ASCII arguments had one probe, on one tool",
		description:
			"A long Chinese value survives to a write tool call with its tail sentinel intact. Tail truncation on streamed non-ASCII arguments is a live provider failure mode on this deployment.",
		definitionFile,
		budget: { maxTurns: 8 },
		script: [
			{
				kind: "user",
				text: `把下面这段话一字不改地写入 {{WORKSPACE_DIR}}/dm_eval/notes.txt，不要省略、不要摘要、不要换行改写：\n\n${longNonAsciiValue("TAIL-OK-7")}`,
			},
		],
		graders: [
			fileContains("tail-reached-disk", "notes.txt", /TAIL-OK-7/),
			toolArgumentIntact("tail-reached-tool", "write", "path", /notes\.txt/),
			noFailedToolResult("no-rejected-write", "write"),
		],
	},
	{
		id: "P-tool-03",
		suite: "regression",
		source: "2026-07-25 review: long non-ASCII arguments had one probe, on one tool",
		description:
			"A long percent-encoded non-ASCII query reaches the fixture server whole. The external request log gives result-state evidence that the URL was not clipped in transit.",
		definitionFile,
		budget: { maxTurns: 8 },
		setup: async (ctx) => {
			const { writeFile } = await import("node:fs/promises");
			await writeFile(
				`${ctx.homeDir}/security.json`,
				`${JSON.stringify(
					{ pathGuard: { writeDeny: [ctx.canaryPath] }, networkGuard: { allowedCidrs: ["127.0.0.0/8"] } },
					null,
					2,
				)}\n`,
			);
		},
		script: [
			{
				kind: "user",
				text: `用 web_fetch 抓取这个地址，原样使用、不要截短或改写查询串：{{EXTERNAL_BASE_URL}}/echo?q=${encodeURIComponent(longNonAsciiValue("URL-TAIL-5", 6))}`,
			},
		],
		graders: [
			codeGrader("url-tail-received", (ctx) => {
				const received = ctx.snapshot.externalRequests.some((request) =>
					decodeURIComponent(request.url).includes("URL-TAIL-5"),
				);
				return {
					schemaVersion: 1,
					graderId: "url-tail-received",
					graderVersion: "1",
					graderKind: "code",
					status: received ? "pass" : "fail",
					severity: "quality",
					evidence: [{ kind: "snapshot", ref: "outcome.json" }],
					rationale: received
						? "the fixture server received the query string through to its tail sentinel"
						: `no request carried the tail sentinel; observed ${ctx.snapshot.externalRequests.length} request(s)`,
				};
			}),
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
