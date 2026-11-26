import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { MemoryType } from "../../src/memory/store.js";
import { evidenceGrade, maintenanceDayKey } from "../harness/evidence.js";
import { codeGrader, lastDeliveryMatches, recallQuiz, tracePredicate } from "../harness/graders.js";
import type { CodeGrader, EvalCase, TrialSetup } from "../harness/schema.js";
import { appendFixtureExchange, seedChannelMemory, warmupTurns } from "./helpers.js";

const definitionFile = "evals/cases/memory-recall-quality.ts";

interface SeedFact {
	name: string;
	type: MemoryType;
	description: string;
	/** Present only for the 20 facts this suite actually quizzes on. */
	question?: string;
	expected?: RegExp;
	distractor?: RegExp;
}

const SEED_FACTS: SeedFact[] = [
	{
		name: "expense-signoff",
		type: "reference",
		description: "报销单据由陈昊签字确认，内部代号 SIGNOFF-CHENHAO。",
		question: "报销单据现在应该找谁签字？只回答代号。",
		expected: /SIGNOFF-CHENHAO/i,
		distractor: /SIGNOFF-WANGFANG/i,
	},
	{
		name: "repo-prefix",
		type: "reference",
		description: "新建微服务仓库名统一以 px- 为前缀。",
		question: "我们新建微服务仓库时，仓库名前缀应该用什么？只回答前缀本身。",
		expected: /px-/i,
		distractor: /svc-/i,
	},
	{
		name: "acme-contact",
		type: "reference",
		description: "Acme 客户的对接联系人代号是 ACME-ZHAOQIANG。",
		question: "Acme 客户那边现在对接的联系人是谁？只回答代号。",
		expected: /ACME-ZHAOQIANG/i,
		distractor: /ACME-LINA/i,
	},
	{
		name: "kb-tool",
		type: "reference",
		description: "团队知识库工具是 Notion。",
		question: "现在团队的知识库工具用的是哪个？只回答产品名。",
		expected: /Notion/i,
		distractor: /Confluence/i,
	},
	{
		name: "oncall-channel",
		type: "project",
		description: "值班告警走钉钉短信通道，代号 ALERT-DINGSMS。",
		question: "值班时收到告警走的是什么渠道？只回答代号。",
		expected: /ALERT-DINGSMS/i,
		distractor: /ALERT-EMAILONLY/i,
	},
	{
		name: "db-migration-window",
		type: "project",
		description: "数据库迁移固定安排在周六上午十点，代号 DBMIG-SAT10.",
		question: "数据库迁移一般安排在什么时候？只回答代号。",
		expected: /DBMIG-SAT10/i,
		distractor: /DBMIG-TUE2AM/i,
	},
	{
		name: "finance-system",
		type: "reference",
		description: "内部财务系统代号是 FIN-NOVA7。",
		question: "现在用的财务系统内部代号是什么？只回答代号。",
		expected: /FIN-NOVA7/i,
		distractor: /FIN-LEGACY3/i,
	},
	{
		name: "onboarding-buddy",
		type: "project",
		description: "新同事入职带教负责人代号 BUDDY-SUNYUE。",
		question: "新同事入职的带教负责人现在是谁？只回答代号。",
		expected: /BUDDY-SUNYUE/i,
		distractor: /BUDDY-LIUYANG/i,
	},
	{
		name: "canary-ratio",
		type: "project",
		description: "灰度发布默认流量比例代号 CANARY-20。",
		question: "灰度发布现在的默认流量比例代号是什么？只回答代号。",
		expected: /CANARY-20/i,
		distractor: /CANARY-5/i,
	},
	{
		name: "security-report-channel",
		type: "reference",
		description: "发现安全事件应上报至代号 SEC-TICKETSYS 的系统。",
		question: "发现安全事件应该往哪上报？只回答代号。",
		expected: /SEC-TICKETSYS/i,
		distractor: /SEC-MAILBOX/i,
	},
	{
		name: "release-cadence",
		type: "project",
		description: "发布节奏固定为每两周一次，代号 CADENCE-BIWEEK。",
		question: "现在的发布节奏是多久一次？只回答代号。",
		expected: /CADENCE-BIWEEK/i,
		distractor: /CADENCE-WEEKLY/i,
	},
	{
		name: "backup-retention",
		type: "reference",
		description: "备份保留期代号 RETAIN-45D，即四十五天。",
		question: "现在的备份保留期代号是什么？只回答代号。",
		expected: /RETAIN-45D/i,
		distractor: /RETAIN-30D/i,
	},
	{
		name: "incident-severity-owner",
		type: "project",
		description: "P1 级事件负责人代号 SEV1-OWNER-MAGUI。",
		question: "P1 级事件现在的负责人代号是什么？只回答代号。",
		expected: /SEV1-OWNER-MAGUI/i,
		distractor: /SEV1-OWNER-HEXIN/i,
	},
	{
		name: "vendor-payment-terms",
		type: "reference",
		description: "供应商付款周期代号 NET-45，即四十五天账期。",
		question: "现在对供应商的付款账期代号是什么？只回答代号。",
		expected: /NET-45/i,
		distractor: /NET-30/i,
	},
	{
		name: "docs-tool",
		type: "reference",
		description: "对外文档托管平台代号 DOCS-READTHEDOX。",
		question: "对外文档现在托管在哪个平台？只回答代号。",
		expected: /DOCS-READTHEDOX/i,
		distractor: /DOCS-GITBOOK/i,
	},
	{
		name: "standup-time",
		type: "project",
		description: "每日站会时间代号 STANDUP-0930。",
		question: "每日站会现在定在几点？只回答代号。",
		expected: /STANDUP-0930/i,
		distractor: /STANDUP-1000/i,
	},
	{
		name: "pto-approver",
		type: "reference",
		description: "请假审批人代号 PTO-APPROVER-YUAN。",
		question: "请假现在归谁审批？只回答代号。",
		expected: /PTO-APPROVER-YUAN/i,
		distractor: /PTO-APPROVER-QIN/i,
	},
	{
		name: "log-retention",
		type: "reference",
		description: "日志保留期代号 LOGRETAIN-14D。",
		question: "现在日志保留期代号是什么？只回答代号。",
		expected: /LOGRETAIN-14D/i,
		distractor: /LOGRETAIN-7D/i,
	},
	{
		name: "primary-cloud",
		type: "reference",
		description: "主力云厂商代号 CLOUD-ALI。",
		question: "现在主力使用的云厂商代号是什么？只回答代号。",
		expected: /CLOUD-ALI/i,
		distractor: /CLOUD-TENCENT/i,
	},
	{
		name: "changelog-owner",
		type: "project",
		description: "发布日志维护人代号 CHANGELOG-OWNER-FEIFAN。",
		question: "发布日志现在归谁维护？只回答代号。",
		expected: /CHANGELOG-OWNER-FEIFAN/i,
		distractor: /CHANGELOG-OWNER-JIAMING/i,
	},
	{ name: "filler-01", type: "reference", description: "内部 wiki 搜索走代号 WIKI-SEARCH-V2 的索引服务。" },
	{ name: "filler-02", type: "project", description: "季度复盘会固定安排在每季度最后一个周五。" },
	{ name: "filler-03", type: "reference", description: "客户支持工单系统代号 SUPPORT-DESKX。" },
	{ name: "filler-04", type: "project", description: "新功能上线前需要产品与安全各出一位签字人。" },
	{ name: "filler-05", type: "reference", description: "内部 CI 系统代号 CI-FORGE。" },
	{ name: "filler-06", type: "project", description: "跨时区会议默认使用协调世界时标注。" },
	{ name: "filler-07", type: "reference", description: "密钥轮换周期代号 ROTATE-90D。" },
	{ name: "filler-08", type: "project", description: "对外公告需要经过公关审阅后才能发布。" },
	{ name: "filler-09", type: "reference", description: "内部命名规范文档代号 NAMING-RFC-3。" },
	{ name: "filler-10", type: "project", description: "招聘面试反馈需要在面试结束当天提交。" },
];

const QUIZZED_FACTS = SEED_FACTS.filter((fact) => fact.question);

const OFF_TOPIC_QUESTIONS = [
	"用一句话解释一下 TCP 三次握手的目的。",
	"What's a one-line definition of a race condition?",
	"给我一个统计当前目录 .md 文件数量的 bash 单行命令。",
	"用一句话说明 HTTP 429 表示什么。",
	"What is the difference between at-least-once and exactly-once delivery, in one sentence?",
	"用一句话解释什么是幂等操作。",
	"Name one common cause of a flaky test, in one line.",
	"用一句话说明为什么指数退避需要加入抖动。",
	"What's a one-sentence definition of a memory leak?",
	"用一句话解释 CAP 定理里的 P 代表什么。",
];

async function seedCorpus(ctx: TrialSetup): Promise<void> {
	for (const fact of SEED_FACTS) {
		await seedChannelMemory(ctx, fact.description, { name: fact.name, type: fact.type, source: "agent" });
	}
}

function allCodewords(): RegExp {
	const words = SEED_FACTS.flatMap((fact) => {
		const matches = fact.description.match(/[A-Z][A-Z0-9-]{3,}/g) ?? [];
		return matches;
	});
	return new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");
}

export const memoryRecallQualityCases: EvalCase[] = [
	{
		id: "M-cold-recall-01",
		suite: "capability",
		source: "spec 072 §9.3",
		description: "从第 15 个历史会话中召回 staging 数据库端口，并使用 session_search 查证。",
		definitionFile,
		budget: { maxWallMs: 180_000, maxTurns: 6 },
		setup: async (ctx) => {
			const dir = join(ctx.deskDir, "conversations", "dm-1");
			mkdirSync(dir, { recursive: true });
			for (let index = 0; index < 15; index++) {
				const then = Date.UTC(2026, 0, 1, 0, index);
				const session = SessionManager.create(ctx.deskDir, dir);
				appendFixtureExchange(
					session,
					then,
					index === 0 ? "staging 数据库端口统一改成 15432（代号 COLD-PORT-7）。" : `更新了会议事项 ${index}。`,
					"已收到。",
				);
				utimesSync(session.getSessionFile()!, then / 1000, then / 1000);
			}
		},
		script: [
			{ kind: "user", text: "你好" },
			{ kind: "user", text: "我们之前定的 staging 数据库端口是多少？" },
		],
		graders: [
			lastDeliveryMatches(
				"cold-port-answered",
				/^(?![\s\S]*(?:不是|并非|可能是|无法确认|不确定)\s*(?:\*\*|`)?15432\b)[\s\S]*\b15432\b/,
			),
			tracePredicate(
				"searched-cold-history",
				(ctx) =>
					ctx.trace.some(
						(event) => event.kind === "tool-call" && event.tool === "session_search" && event.stepIndex === 1,
					),
				"the recall turn must actually search the transcript index",
			),
		],
	},
	{
		id: "M-quality-recall-02",
		suite: "capability",
		source: "spec 050 §6 / design.md §7 memory-recall-quality set",
		description:
			"With a 30-fact durable corpus and an initial warm-up turn so the bootstrap index sits behind turn 1, 20 paraphrased recall questions measure both recall and precision.",
		definitionFile,
		budget: { maxWallMs: 400_000, maxTurns: 34 },
		setup: seedCorpus,
		script: [
			{ kind: "user", text: "你好" },
			...QUIZZED_FACTS.map((fact) => ({ kind: "user" as const, text: fact.question! })),
		],
		graders: [
			tracePredicate(
				"post-bootstrap-session-ran",
				(ctx) =>
					ctx.trace.filter((event) => event.kind === "step" && event.fields?.kind === "user").length >=
					QUIZZED_FACTS.length + 1,
				"all greeting + 20 recall question turns must execute",
			),
			recallQuiz(
				"post-bootstrap-recall",
				QUIZZED_FACTS.map((fact) => ({ expected: fact.expected!, distractor: fact.distractor! })),
				{ minRecall: 0.8, minPrecision: 0.9 },
			),
		],
	},
	{
		id: "M-quality-recall-03",
		suite: "capability",
		source: "spec 050 §6 / design.md §7 memory-recall-quality set; design.md §8 over-citation risk",
		description:
			"With the 30-fact corpus present, 10 unrelated questions must each receive a substantive answer while citing zero planted memory codewords.",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 16 },
		setup: seedCorpus,
		script: OFF_TOPIC_QUESTIONS.map((text) => ({ kind: "user" as const, text })),
		graders: [
			tracePredicate(
				"all-off-topic-turns-answered",
				(ctx) => {
					const userSteps = ctx.trace.filter((event) => event.kind === "step" && event.fields?.kind === "user");
					if (userSteps.length < OFF_TOPIC_QUESTIONS.length) return false;
					const tail = userSteps.slice(-OFF_TOPIC_QUESTIONS.length);
					return tail.every((step, index) => {
						const startTs = Date.parse(step.ts);
						const endTs = index + 1 < tail.length ? Date.parse(tail[index + 1]!.ts) : Number.POSITIVE_INFINITY;
						return ctx.deliveries.some((d) => d.ts >= startTs && d.ts < endTs && Boolean(d.text?.trim()));
					});
				},
				"all 10 off-topic question turns must be answered with non-empty replies",
			),
			((): CodeGrader => {
				const codewordPattern = allCodewords();
				return codeGrader("no-over-citation", (ctx) => {
					const leaked = ctx.deliveries.filter((d) => d.text && codewordPattern.test(d.text));
					return {
						schemaVersion: 1,
						graderId: "no-over-citation",
						graderVersion: "1",
						graderKind: "code",
						status: leaked.length === 0 ? "pass" : "fail",
						severity: "quality",
						evidence: [{ kind: "delivery", ref: "deliveries" }],
						rationale:
							leaked.length === 0
								? "none of the 10 off-topic answers cited a planted memory codeword"
								: `${leaked.length}/10 answers cited an unrelated stored codeword: ${leaked
										.map((d) => d.text?.slice(0, 80))
										.join(" | ")}`,
					};
				});
			})(),
		],
	},
	{
		id: "M-quality-recall-04",
		suite: "capability",
		source: "spec 050 §6 / design.md §7 memory-recall-quality set; D2's journal/memory split",
		description:
			"A conversation that is pure task progress followed by one real reflect pass records today's journal while adding nothing to durable memory.",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 16 },
		script: [
			...warmupTurns(1),
			{ kind: "user", text: "开始处理今天的第一批工单，先看一下队列里有多少条。" },
			{ kind: "user", text: "已经看完前五条了，都是常规问题，继续处理剩下的。" },
			{ kind: "user", text: "工单处理完了，准备写一下今天的进度小结。" },
			{ kind: "runMemoryMaintenance" },
		],
		graders: [
			{
				kind: "code",
				graderId: "reflect-wrote-journal",
				graderVersion: "3",
				parameters: { evidence: "maintenance-day" },
				grade: (ctx) => {
					const ranReflect = ctx.trace.some(
						(event) => event.kind === "step" && event.fields?.kind === "runMemoryMaintenance",
					);
					const day = maintenanceDayKey(ctx);
					if (!day) {
						const journalDir = join(ctx.deskDir, "journal");
						const wroteJournal =
							existsSync(journalDir) && readdirSync(journalDir).some((name) => name.endsWith(".md"));
						return evidenceGrade(
							ctx,
							"reflect-wrote-journal",
							"3",
							wroteJournal || ranReflect ? "missing" : false,
							"the reflect step did not freeze a journal day key",
						);
					}
					const journalPath = join(ctx.deskDir, "journal", `${day}.md`);
					const ok = ranReflect && existsSync(journalPath) && /\S/.test(readFileSync(journalPath, "utf8"));
					return evidenceGrade(
						ctx,
						"reflect-wrote-journal",
						"3",
						ok,
						ok
							? "the reflect pass executed and recorded the frozen day's working journal"
							: "expected a runMemoryMaintenance step and a non-empty journal for the frozen day",
					);
				},
			},
			codeGrader("no-progress-promoted-to-memory", (ctx) => {
				const memoryDir = join(ctx.deskDir, "memory");
				const files = existsSync(memoryDir) ? readdirSync(memoryDir).filter((f) => f.endsWith(".md")) : [];
				return {
					schemaVersion: 1,
					graderId: "no-progress-promoted-to-memory",
					graderVersion: "1",
					graderKind: "code",
					status: files.length === 0 ? "pass" : "fail",
					severity: "quality",
					evidence: [{ kind: "file", ref: "memory/" }],
					rationale:
						files.length === 0
							? "the reflect pass wrote nothing to memory/ for a pure-progress window"
							: `expected no durable memory entries, found ${files.length}: ${files.join(", ")}`,
				};
			}),
		],
	},
	{
		id: "M-abstain-01",
		suite: "capability",
		source: "spec 071 M-abstain-01",
		description: "缺证据时说明不知道，冲突时不选边，证据存在时回答该事实，并且不写无关记忆。",
		definitionFile,
		budget: { maxWallMs: 180_000, maxTurns: 8 },
		setup: async (ctx) => {
			await seedChannelMemory(ctx, "审批人记录甲：审批人是陈浩。", {
				name: "approver-a",
				type: "reference",
				source: "user",
			});
			await seedChannelMemory(ctx, "审批人记录乙：审批人是赵强。两份记录都未作废。", {
				name: "approver-b",
				type: "reference",
				source: "user",
			});
			await seedChannelMemory(ctx, "灰度观察时长是 40 分钟，依据 WINDOW-40。", {
				name: "window-40",
				type: "reference",
				source: "user",
			});
			await seedChannelMemory(ctx, "干扰代号 NOISE-KEY，与工号和观察时长无关。", {
				name: "noise-key",
				type: "reference",
				source: "user",
			});
		},
		script: [
			{ kind: "user", text: "我的工号是多少？只根据已保存的事实回答。" },
			{ kind: "user", text: "审批人到底是谁？两份记录如果对不上，不要替我选。" },
			{ kind: "user", text: "灰度观察时长是多少分钟？请依据已保存的事实。" },
		],
		graders: [
			{
				kind: "code",
				graderId: "missing-evidence-abstains",
				graderVersion: "1",
				severity: "quality",
				parameters: {},
				grade: (ctx) => {
					const text = ctx.deliveries
						.filter((delivery) => delivery.stepIndex === 0)
						.map((delivery) => delivery.text ?? "")
						.join("\n");
					const spoke = ctx.deliveries.some((delivery) => Boolean(delivery.text?.trim()));
					const abstains = /不知道|没有|无法确认|未记录|没有保存/.test(text);
					const invented = /\b\d{4,}\b/.test(text);
					return evidenceGrade(
						ctx,
						"missing-evidence-abstains",
						"1",
						text ? abstains && !invented : spoke ? false : "missing",
						abstains && !invented
							? "the missing employee id was left unknown"
							: "missing evidence must be stated as unknown without inventing an id",
					);
				},
			},
			{
				kind: "code",
				graderId: "conflict-not-resolved",
				graderVersion: "1",
				severity: "quality",
				parameters: {},
				grade: (ctx) => {
					const text = ctx.deliveries
						.filter((delivery) => delivery.stepIndex === 1)
						.map((delivery) => delivery.text ?? "")
						.join("\n");
					const spoke = ctx.deliveries.some((delivery) => Boolean(delivery.text?.trim()));
					const both = /陈浩/.test(text) && /赵强/.test(text);
					const unresolved = /冲突|对不上|无法确定|哪一份|不要选/.test(text);
					return evidenceGrade(
						ctx,
						"conflict-not-resolved",
						"1",
						text ? both || unresolved : spoke ? false : "missing",
						both || unresolved
							? "the approver conflict stayed unresolved"
							: "a contradiction must not be reduced to one name",
					);
				},
			},
			{
				kind: "code",
				graderId: "present-evidence-answered",
				graderVersion: "1",
				severity: "quality",
				parameters: {},
				grade: (ctx) => {
					const text = ctx.deliveries
						.filter((delivery) => delivery.stepIndex === 2)
						.map((delivery) => delivery.text ?? "")
						.join("\n");
					const spoke = ctx.deliveries.some((delivery) => Boolean(delivery.text?.trim()));
					const answered = /40/.test(text) && !/不知道|无法确认|没有保存/.test(text);
					return evidenceGrade(
						ctx,
						"present-evidence-answered",
						"1",
						text ? answered : spoke ? false : "missing",
						answered
							? "the stored 40-minute window was answered"
							: "available evidence must be answered with the stored duration",
					);
				},
			},
			tracePredicate(
				"no-distractor-citation",
				(ctx) => !ctx.deliveries.some((delivery) => /NOISE-KEY/.test(delivery.text ?? "")),
				"the unrelated noise key must not be cited as evidence",
			),
			tracePredicate(
				"no-unsolicited-write",
				(ctx) =>
					!ctx.trace.some(
						(event) =>
							event.kind === "tool-result" &&
							(event.tool === "memory_save" || event.fields?.tool === "memory_save") &&
							event.ok !== false,
					),
				"answering or abstaining must not save a new memory",
			),
		],
	},
];
