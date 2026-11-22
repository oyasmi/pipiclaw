import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evidenceGrade, maintenanceDayKey } from "../harness/evidence.js";
import {
	codeGrader,
	deliveryMatches,
	deliveryNotMatches,
	fileNotContains,
	lastDeliveryMatches,
	lastDeliveryNotMatches,
	noDeliveriesAfterStep,
	noFailedToolResult,
	toolCallCount,
	tracePredicate,
} from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";
import { warmupTurns, writeSubAgent } from "./helpers.js";

const definitionFile = "evals/cases/regression.ts";
const mediaFixture = "account,total\nalpha,42\n";

export const regressionCases: EvalCase[] = [
	{
		id: "M-maint-01",
		suite: "regression",
		source:
			"2026-07-25 review: memory maintenance pipeline; adapted 2026-09-04 (spec 050) for journal + explicit non-promotion",
		description:
			"One production reflect pass over a warm channel records what happened in today's journal, and — because the user explicitly said not to — does not promote it to durable memory.",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 16 },
		script: [
			...warmupTurns(3),
			{ kind: "user", text: "记一下：这次排查的根因代号是 ROOTCAUSE-88，先不用写进长期记忆。" },
			{ kind: "runMemoryMaintenance" },
		],
		graders: [
			{
				kind: "code",
				graderId: "journal-written",
				graderVersion: "3",
				parameters: { evidence: "maintenance-day" },
				grade: (ctx) => {
					const day = maintenanceDayKey(ctx);
					if (!day) {
						const journalDir = join(ctx.deskDir, "journal");
						const wroteJournal =
							existsSync(journalDir) && readdirSync(journalDir).some((name) => name.endsWith(".md"));
						return evidenceGrade(
							ctx,
							"journal-written",
							"3",
							wroteJournal ? "missing" : false,
							"the maintenance step did not freeze a journal day key",
						);
					}
					const relativePath = `journal/${day}.md`;
					const path = join(ctx.deskDir, relativePath);
					const ok = existsSync(path) && /ROOTCAUSE-88/i.test(readFileSync(path, "utf8"));
					return evidenceGrade(
						ctx,
						"journal-written",
						"3",
						ok,
						ok
							? `${relativePath} matched ROOTCAUSE-88 using the frozen maintenance day`
							: `${relativePath} was missing or did not record ROOTCAUSE-88 for the frozen maintenance day`,
					);
				},
			},
			fileNotContains("not-promoted-to-durable-memory", "MEMORY.md", /ROOTCAUSE-88/i),
			noDeliveriesAfterStep("maintenance-is-silent", "runMemoryMaintenance"),
		],
	},
	{
		id: "M-search-01",
		suite: "regression",
		source: "2026-07-26 quality pass: cold transcript storage recall and cross-desk isolation",
		description:
			"A natural request about an older conversation selects session_search, retrieves the current desk's exact fact, and excludes a same-keyword fact from another desk.",
		definitionFile,
		setup: async (ctx) => {
			const conversationDir = join(ctx.deskDir, "conversations", "dm-1");
			await mkdir(conversationDir, { recursive: true });
			await writeFile(
				join(conversationDir, "log.jsonl"),
				`${JSON.stringify({
					date: "2026-04-19T00:00:00.000Z",
					userName: "Evaluator",
					text: "billing migration 的变更工单是 CHANGE-731，回滚负责人是 platform-oncall。",
					isBot: false,
				})}\n`,
			);
			const sibling = join(ctx.workspaceDir, "desk-other", "conversations", "dm-1");
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
		id: "E-schedule-01",
		suite: "regression",
		source: "2026-07-26 quality pass: natural-language scheduled event creation",
		description:
			"A natural-language future follow-up becomes one validated, channel-owned one-shot event through event_manage.",
		definitionFile,
		script: [
			{
				kind: "user",
				text: "请安排一次名为 release-followup 的跟进：10 分钟后提醒我“Review release candidate RC-17”。这是未来提醒，不要现在执行。",
			},
		],
		graders: [
			toolCallCount("one-event-create", "event_manage", 1, ["action", /^create$/]),
			noFailedToolResult("valid-event-definition", "event_manage"),
			codeGrader("owned-one-shot-persisted", (ctx) => {
				const path = join(ctx.deskDir, "events", "release-followup.json");
				let definition: Record<string, unknown> | undefined;
				try {
					definition = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
				} catch {}
				const pass =
					definition?.type === "one-shot" &&
					definition.channelId === "dingtalk:dm:eval" &&
					Date.parse(String(definition.at)) - Date.parse(ctx.trace[0]?.ts ?? "") >= 8 * 60_000 &&
					Date.parse(String(definition.at)) - Date.parse(ctx.trace[0]?.ts ?? "") <= 12 * 60_000 &&
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
		source: "2026-07-26 quality pass: native DingTalk attachment delivery",
		description:
			"A request for an attachment selects send_media and delivers the exact generated bytes under the requested filename instead of pasting the file into chat.",
		definitionFile,
		setup: async (ctx) => {
			await writeFile(join(ctx.deskDir, "quarterly-report.csv"), mediaFixture);
		},
		script: [
			{
				kind: "user",
				text: "把刚生成的 {{DESK_DIR}}/quarterly-report.csv 作为名为 q2-summary.csv 的可下载附件发给我；不要在聊天里粘贴 CSV 内容。",
			},
		],
		graders: [
			toolCallCount("no-unnecessary-task", "task_create", 0),
			toolCallCount("no-step-tool-in-chat", "task_report", 0),
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
		id: "M-journal-01",
		suite: "regression",
		source: "2026-09-10 playbook review: journal search wiring and evidence-based recall",
		description: "A historical journal-only fact is recovered with its source rather than guessed from the index.",
		definitionFile,
		setup: async (ctx) => {
			await mkdir(join(ctx.deskDir, "journal"), { recursive: true });
			await writeFile(
				join(ctx.deskDir, "journal", "2020-01-02.md"),
				"# 2020-01-02\n- iris launch 的批准编号为 IRIS-7319。\n",
			);
		},
		script: [{ kind: "user", text: "之前 iris launch 的批准编号是什么？请查工作记录并给出来源日期。" }],
		graders: [
			tracePredicate(
				"uses-memory-search",
				(ctx) => {
					const count = ctx.trace.filter(
						(event) => event.kind === "tool-call" && event.tool === "memory_search",
					).length;
					return count >= 1 && count <= 2;
				},
				"retrieve journal evidence without repeated empty searches",
			),
			noFailedToolResult("search-succeeded", "memory_search"),
			lastDeliveryMatches("recalled-evidence", /IRIS-7319/),
			lastDeliveryMatches("dated-source", /2020-01-02/),
		],
	},
	{
		id: "A-route-01",
		suite: "regression",
		source: "046 tool schema partitioning D5 — role-first delegation",
		description:
			"When a matching configured sub-agent already exists, delegation names it via `subagent` (`agent`) rather than redefining an equivalent one-off with `subagent_inline`.",
		definitionFile,
		setup: async (ctx) => {
			await mkdir(ctx.deskDir, { recursive: true });
			await writeFile(
				join(ctx.deskDir, "inventory.txt"),
				"service: billing\nowner: platform-team\nSECRET-OWNER-TOKEN: OWNER-ROUTE-3\n",
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
				text: "把下面的只读查找委派给子代理：读取 {{DESK_DIR}}/inventory.txt，找出 SECRET-OWNER-TOKEN 的值，再把子代理的发现告诉我。",
			},
		],
		graders: [
			tracePredicate(
				"used-configured-role",
				(ctx) =>
					ctx.trace.some(
						(event) =>
							event.kind === "tool-call" && event.tool === "subagent" && event.fields?.agent === "eval-scout",
					),
				"a matching configured role exists and must be named via `agent`",
			),
			noFailedToolResult("configured-role-succeeded", "subagent"),
			tracePredicate(
				"did-not-redefine-inline",
				(ctx) => !ctx.trace.some((event) => event.kind === "tool-call" && event.tool === "subagent_inline"),
				"must not redefine an equivalent one-off agent inline when a configured role already fits",
			),
			deliveryMatches("subagent-finding-returned", /OWNER-ROUTE-3/),
		],
	},
];
