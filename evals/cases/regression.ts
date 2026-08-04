import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	codeGrader,
	deliveryMatches,
	deliveryNotMatches,
	driverDispatchCount,
	fileContains,
	fileNotContains,
	lastDeliveryMatches,
	lastDeliveryNotMatches,
	noDeliveriesAfterStep,
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
const mediaFixture = "account,total\nalpha,42\n";

export const regressionCases: EvalCase[] = [
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
			tracePredicate(
				"read-on-every-wake",
				(ctx) =>
					ctx.trace.filter(
						(event) =>
							event.kind === "tool-call" &&
							event.tool === "read" &&
							/resume-three\.md/.test(event.fields?.path ?? event.fields?.file_path ?? ""),
					).length >= 3,
				"each of the three wakes must re-read the durable task instead of relying on stale context",
			),
			taskFrontmatter(
				"release-still-open",
				"resume-three",
				(frontmatter) => frontmatter.archiveOutcome === undefined,
			),
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
			// v2 keeps the live stage and records a structured governor stop orthogonally.
			taskFrontmatter(
				"deadline-escalated",
				"expired-task",
				(frontmatter, content) =>
					hasStatus(frontmatter, "active") &&
					frontmatter.enabled === false &&
					frontmatter.control?.stop?.by === "governor" &&
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
				status: "sleeping",
				wake: "2025-12-31T00:00:00.000Z",
				schedule: "0 0 * * *",
				body: "# Task\n\n## Goal\nOn cycle start, record CYCLE-STARTED, then close this evidence-only cycle with task_manage complete. The runtime opens the recurring cycle before dispatch; do not call a cycle-opening action.\n\n## DoD\n- [ ] CYCLE-STARTED recorded\n",
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
			"A fact stated mid-conversation survives six unrelated turns and one real maintenance pass, then is recalled.",
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
		graders: [lastDeliveryMatches("warm-recall", /^\s*THURSDAY-GATE[。.!]?\s*$/i)],
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
			noDeliveriesAfterStep("maintenance-is-silent", "runMemoryMaintenance"),
		],
	},
	{
		id: "M-search-01",
		suite: "regression",
		source: "2026-07-26 quality pass: cold transcript storage had no behavior coverage",
		description:
			"A natural request about an older conversation selects session_search, retrieves the current channel's exact fact, and excludes a same-keyword fact from another channel.",
		definitionFile,
		setup: async (ctx) => {
			const { mkdir, writeFile } = await import("node:fs/promises");
			await mkdir(ctx.channelDir, { recursive: true });
			await writeFile(
				join(ctx.channelDir, "log.jsonl"),
				`${JSON.stringify({
					date: "2026-04-19T00:00:00.000Z",
					userName: "Evaluator",
					text: "billing migration 的变更工单是 CHANGE-731，回滚负责人是 platform-oncall。",
					isBot: false,
				})}\n`,
			);
			const sibling = join(ctx.workspaceDir, "dm_other");
			await mkdir(sibling, { recursive: true });
			await writeFile(
				join(sibling, "log.jsonl"),
				`${JSON.stringify({
					date: "2026-04-20T00:00:00.000Z",
					userName: "Other User",
					text: "billing migration 的变更工单是 CHANGE-999。",
					isBot: false,
				})}\n`,
			);
		},
		script: [
			{
				kind: "user",
				text: "我们之前聊过的 billing migration 变更工单号是什么？请从这个会话的历史记录里找出来，只回答工单号。",
			},
		],
		graders: [
			toolCallCount("single-shot-cold-search", "session_search", 1),
			noFailedToolResult("no-malformed-cold-search", "session_search"),
			lastDeliveryMatches("current-channel-hit", /^\s*CHANGE-731[。.!]?\s*$/i),
			lastDeliveryNotMatches("no-sibling-leak", /CHANGE-999/i),
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
			await writeSubAgent(ctx, "eval-writer", {
				description: "文档编辑：根据已经确认的内容修改工作区 Markdown 文件。",
				tools: ["read", "write", "edit"],
				body: "你负责修改已经指定的文档。没有明确编辑要求时，不要承担只读调查。",
			});
		},
		script: [
			{
				kind: "user",
				text: "把下面的只读查找委派给最合适的已配置工作区子代理，不要由主代理直接读文件：读取 {{CHANNEL_DIR}}/inventory.txt，找出 SECRET-OWNER-TOKEN 的值，再把子代理的发现告诉我。",
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
			toolArgumentIntact("tail-reached-tool", "write", "content", /TAIL-OK-7/),
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
			lastDeliveryMatches("new-region", /^\s*eu-west-1[。.!]?\s*$/i),
			lastDeliveryNotMatches("old-region-not-recalled", /us-east-1/i),
			fileContains("correction-persisted", "MEMORY.md", /eu-west-1/i),
			fileNotContains("old-region-removed", "MEMORY.md", /us-east-1/i),
		],
	},
	{
		id: "E-schedule-01",
		suite: "regression",
		source: "2026-07-26 quality pass: scheduled events were covered only by coached e2e mechanism tests",
		description:
			"A natural-language future follow-up becomes one validated, channel-owned one-shot event through event_manage.",
		definitionFile,
		script: [
			{
				kind: "user",
				text: "请安排一次名为 release-followup 的跟进：在 2099-01-02T10:00:00+08:00 提醒我“Review release candidate RC-17”。这是未来提醒，不要现在执行。",
			},
		],
		graders: [
			toolCallCount("one-event-create", "event_manage", 1, ["action", /^create$/]),
			noFailedToolResult("valid-event-definition", "event_manage"),
			codeGrader("owned-one-shot-persisted", (ctx) => {
				const path = join(ctx.workspaceDir, "events", "release-followup.json");
				let definition: Record<string, unknown> | undefined;
				try {
					definition = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				} catch {}
				const pass =
					definition?.type === "one-shot" &&
					definition.channelId === "dm_eval" &&
					Date.parse(String(definition.at)) === Date.parse("2099-01-02T10:00:00+08:00") &&
					definition.text === "Review release candidate RC-17";
				return {
					schemaVersion: 1,
					graderId: "owned-one-shot-persisted",
					graderVersion: "1",
					graderKind: "code",
					status: pass ? "pass" : "fail",
					severity: "quality",
					evidence: [{ kind: "file", ref: "events/release-followup.json" }],
					rationale: pass
						? "the validated one-shot event retained its owner, time, and exact reminder"
						: `unexpected event definition: ${JSON.stringify(definition)}`,
				};
			}),
		],
	},
	{
		id: "P-media-01",
		suite: "regression",
		source: "2026-07-26 quality pass: native DingTalk attachment delivery had no behavior coverage",
		description:
			"A request for an attachment selects send_media and delivers the exact generated bytes under the requested filename instead of pasting the file into chat.",
		definitionFile,
		setup: async (ctx) => {
			const { writeFile } = await import("node:fs/promises");
			await writeFile(join(ctx.channelDir, "quarterly-report.csv"), mediaFixture);
		},
		script: [
			{
				kind: "user",
				text: "把刚生成的 {{CHANNEL_DIR}}/quarterly-report.csv 作为名为 q2-summary.csv 的可下载附件发给我；不要在聊天里粘贴 CSV 内容。",
			},
		],
		graders: [
			toolCallCount("one-native-send", "send_media", 1, ["path", /quarterly-report\.csv$/]),
			noFailedToolResult("media-send-succeeded", "send_media"),
			deliveryNotMatches("csv-not-pasted", /account,total|alpha,42/i),
			codeGrader("exact-attachment", (ctx) => {
				const delivery = ctx.snapshot.deliveries.find((candidate) => candidate.method === "sendMedia");
				const expectedHash = createHash("sha256").update(mediaFixture).digest("hex");
				const pass =
					delivery?.media?.fileName === "q2-summary.csv" &&
					delivery.media.kind === "file" &&
					delivery.media.bytes === Buffer.byteLength(mediaFixture) &&
					delivery.media.hash === expectedHash;
				return {
					schemaVersion: 1,
					graderId: "exact-attachment",
					graderVersion: "1",
					graderKind: "code",
					status: pass ? "pass" : "fail",
					severity: "quality",
					evidence: [{ kind: "snapshot", ref: "outcome.json" }],
					rationale: pass
						? "the requested filename and exact fixture bytes reached the transport"
						: `unexpected media delivery: ${JSON.stringify(delivery?.media)}`,
				};
			}),
		],
	},
	{
		id: "P-playbook-01",
		suite: "regression",
		source: "026 playbook activation",
		description: "A task wake loads the task-driving playbook from the runtime catalog.",
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
];
