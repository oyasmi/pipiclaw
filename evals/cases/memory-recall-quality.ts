import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryType } from "../../src/memory/store.js";
import { recallQuiz } from "../harness/graders.js";
import type { CodeGrader, EvalCase, TrialSetup } from "../harness/schema.js";
import { seedChannelMemory, warmupTurns } from "./helpers.js";

const definitionFile = "evals/cases/memory-recall-quality.ts";

/**
 * Spec 050 §6 / design.md §7: the one piece of behavioral evidence for the redesign's central
 * claim — "a model reading a compact index finds a stored fact at least as reliably as the old
 * per-turn lexical/rerank recall did, and does not drag in memory it was never asked about."
 * These three cases share one 30-entry seed corpus; run `npm run eval` against master before
 * merging this spec to keep a pre-v2 baseline the report can diff against (there is nothing to
 * diff against for M-write/-recall cases predating this file, since the v1 recall pipeline they
 * exercised no longer exists).
 */

interface SeedFact {
	name: string;
	type: MemoryType;
	description: string;
	/** Present only for the 20 facts this suite actually quizzes on. */
	question?: string;
	expected?: RegExp;
	distractor?: RegExp;
}

// 30 facts: 20 quizzed with a differently-worded question, 10 pure filler (seeded, never asked
// about — they exist so the corpus is realistically sized and the index is not trivially small).
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
	// Filler: seeded but never asked about.
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

// 10 questions with no relationship to any seeded fact — general knowledge or generic dev
// questions, the same shape `warmupTurns` uses elsewhere in this suite.
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
		id: "M-quality-recall-01",
		suite: "capability",
		source: "spec 050 §6 / design.md §7 memory-recall-quality set",
		description:
			"30 durable channel facts are seeded directly (the same primitive memory_save/the reflect pass write " +
			"through). 20 differently-worded questions are asked back to back, none reusing the stored fact's own " +
			"wording. Because the whole corpus fits comfortably under the first-turn index budget, this is " +
			"primarily a test that the generated index is legible and the model uses it correctly — the harder, " +
			"over-budget case is M-quality-recall-02.",
		definitionFile,
		budget: { maxWallMs: 400_000, maxTurns: 30 },
		setup: seedCorpus,
		script: QUIZZED_FACTS.map((fact) => ({ kind: "user" as const, text: fact.question! })),
		graders: [
			recallQuiz(
				"in-budget-recall",
				QUIZZED_FACTS.map((fact) => ({ expected: fact.expected!, distractor: fact.distractor! })),
				{ minRecall: 0.85, minPrecision: 0.9 },
			),
		],
	},
	{
		id: "M-quality-recall-02",
		suite: "capability",
		source: "spec 050 §6 / design.md §7 memory-recall-quality set",
		description:
			"The same 30-fact corpus, but the channel is reset to a new session first, so the model must open the " +
			"index (bundled in <memory_bootstrap>) and, for anything the tiered index omitted, use memory_search — " +
			"there is no per-turn recall retrying on its own.",
		definitionFile,
		budget: { maxWallMs: 400_000, maxTurns: 34 },
		setup: seedCorpus,
		script: [
			{ kind: "user", text: "你好" },
			...QUIZZED_FACTS.map((fact) => ({ kind: "user" as const, text: fact.question! })),
		],
		graders: [
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
			"With the same 30-fact corpus present, 10 questions genuinely unrelated to any of it are asked. A " +
			"model that over-uses background memory drags a stored codeword into an answer that has no business " +
			"citing one; this fails if any of the 30 planted codewords leaks into any of the 10 answers.",
		definitionFile,
		budget: { maxWallMs: 300_000, maxTurns: 16 },
		setup: seedCorpus,
		script: OFF_TOPIC_QUESTIONS.map((text) => ({ kind: "user" as const, text })),
		graders: [
			((): CodeGrader => {
				const codewordPattern = allCodewords();
				return {
					kind: "code",
					graderId: "no-over-citation",
					graderVersion: "1",
					severity: "quality",
					grade: (ctx) => {
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
					},
				};
			})(),
		],
	},
	{
		id: "M-quality-recall-04",
		suite: "capability",
		source: "spec 050 §6 / design.md §7 memory-recall-quality set; D2's journal/memory split",
		description:
			"A conversation that is pure task progress — no fact worth remembering across sessions — followed by " +
			"one real reflect pass. Asserts the pass added nothing to durable memory (the reflect prompt's D2 " +
			"three-way split: journal / task / memory, never memory for in-progress state).",
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
				graderId: "no-progress-promoted-to-memory",
				graderVersion: "1",
				severity: "quality",
				grade: (ctx) => {
					const memoryDir = join(ctx.channelDir, "memory");
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
				},
			},
		],
	},
];
