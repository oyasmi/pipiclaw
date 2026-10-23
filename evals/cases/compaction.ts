import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { fixtureToken } from "../harness/fixture-seed.js";
import { tracePredicate } from "../harness/graders.js";
import type { EvalCase } from "../harness/schema.js";

export const compactionCases: EvalCase[] = [
	{
		id: "M-compaction-01",
		suite: "capability",
		source: "2026-10-22 compaction review",
		description:
			"真实压缩较早的中文任务说明后，继续生成带原始限制和精确标识的文件，不把临时任务进度当作长期记忆依赖。",
		definitionFile: "evals/cases/compaction.ts",
		dependencies: [
			"src/agent/session/compaction.ts",
			"src/agent/session/compaction-input.ts",
			"src/agent/session/compaction-summary.ts",
			"src/agent/session/compaction-snapshot.ts",
			"src/memory/boundary-work.ts",
		],
		budget: { maxWallMs: 180_000, maxCostUsd: 0.5, maxTurns: 5 },
		artifacts: [
			{ root: "workspace", path: "." },
			{ root: "home", path: "compaction-evidence.json", optional: true },
		],
		setup: async (ctx) => {
			const conversationDir = join(ctx.dotDir, "conversations/dm-1");
			const manager = SessionManager.open(join(conversationDir, "context.jsonl"), conversationDir, ctx.dotDir);
			const settings = JSON.parse(readFileSync(join(ctx.homeDir, "settings.json"), "utf8"));
			const usage = {
				input: 1000,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1010,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			const assistant = (text: string) => ({
				role: "assistant" as const,
				content: [{ type: "text" as const, text }],
				api: "openai-completions" as const,
				provider: settings.defaultProvider,
				model: settings.defaultModel,
				stopReason: "stop" as const,
				timestamp: 2,
				usage,
			});
			manager.appendMessage({
				role: "user",
				timestamp: 1,
				content: `当前任务：在 dot 工作目录写 handoff.json，内容为 {"region":"eu-west-1","approval":"${fixtureToken(ctx.seed, "APPROVAL")}","deploy":false}。只生成交接文件，不实际部署，不等待额外批准，不要求我重复信息。保留字段类型，尤其 deploy 是布尔值 false。`,
			});
			manager.appendMessage(assistant("已确认任务目标、授权标识和禁止部署的约束。"));
			manager.appendMessage({ role: "user", content: "先核对资料，稍后继续写文件。", timestamp: 3 });
			manager.appendMessage(assistant("Routine verification record. ".repeat(4000)));
			// Observe only fixture checkpoints; raw transcripts remain excluded by the shared artifact policy.
			const path = join(conversationDir, "context.jsonl");
			const observer = watch(path, { persistent: false }, () => {
				try {
					const checkpoints = readFileSync(path, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
						.filter((entry) => entry.type === "compaction");
					if (!checkpoints.length) return;
					writeFileSync(join(ctx.homeDir, "compaction-evidence.json"), JSON.stringify(checkpoints));
					observer.close();
				} catch {
					/* the next append notification retries an incomplete read */
				}
			});
		},
		script: [{ kind: "compact" }, { kind: "user", text: "继续完成刚才的交接文件任务，写完后告诉我。" }],
		graders: [
			tracePredicate(
				"compaction-occurred",
				(ctx) => {
					const path = join(ctx.dotDir, "conversations/dm-1/context.jsonl");
					return (
						existsSync(path) &&
						readFileSync(path, "utf8")
							.split("\n")
							.filter(Boolean)
							.some((line) => JSON.parse(line).type === "compaction")
					);
				},
				"the real session must contain a persisted compaction, not merely a successful continuation",
			),
			tracePredicate(
				"checkpoint-task-retained",
				(ctx) => {
					const path = join(ctx.dotDir, "handoff.json");
					if (!existsSync(path)) return false;
					try {
						const result = JSON.parse(readFileSync(path, "utf8"));
						return (
							result.region === "eu-west-1" &&
							result.approval === fixtureToken(ctx.seed, "APPROVAL") &&
							result.deploy === false
						);
					} catch {
						return false;
					}
				},
				"the artifact must preserve the goal, exact seeded identifier, and negative constraint after compaction",
			),
		],
	},
];

const manualCheckpoint = compactionCases[0]!;
compactionCases.push({
	...manualCheckpoint,
	id: "M-compaction-02",
	description: "后台分段压缩长中文消息中段的目标和禁止项后，在下一请求边界续接原任务。",
	setup: async (ctx) => {
		await manualCheckpoint.setup!(ctx);
		const settings = JSON.parse(readFileSync(join(ctx.homeDir, "settings.json"), "utf8"));
		settings.logging = { ...settings.logging, level: "info", file: { ...settings.logging?.file, enabled: true } };
		writeFileSync(join(ctx.homeDir, "settings.json"), JSON.stringify(settings));
		const runtime = await ModelRuntime.create({
			authPath: join(ctx.homeDir, "auth.json"),
			modelsPath: join(ctx.homeDir, "models.json"),
		});
		const model = runtime.getModel(settings.defaultProvider, settings.defaultModel);
		if (!model) throw new Error("Background compaction fixture requires the configured model window.");
		const measuredInput = Math.floor((model.contextWindow - 16384 - 4096) * 0.75);
		const path = join(ctx.dotDir, "conversations/dm-1/context.jsonl");
		const entries = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const first = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
		first.message.content = `较早的核对记录：${"甲".repeat(33000)}\n${first.message.content}\n后续例行记录：${"乙".repeat(33000)}`;
		for (const entry of entries)
			if (entry.type === "message" && entry.message.role === "assistant") {
				entry.message.usage.input = measuredInput;
				entry.message.usage.totalTokens = measuredInput + 10;
			}
		writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	},
	script: [
		{ kind: "user", text: "先只回复确认，不创建交接文件；等我下一条消息再继续原任务。" },
		{
			kind: "waitFor",
			timeoutMs: 65000,
			failureCategory: "runtime",
			predicate: (ctx) => {
				const path = join(ctx.homeDir, "state/logs/runtime.jsonl");
				return (
					existsSync(path) &&
					readFileSync(path, "utf8")
						.split("\n")
						.filter(Boolean)
						.some((line) => JSON.parse(line).event === "agent.compaction.ready")
				);
			},
		},
		{
			kind: "user",
			text: "现在继续原任务，重新写入 handoff.json，覆盖可能已有的旧文件；直接读取文件核对 JSON 内容即可，无需运行额外验证脚本。",
		},
	],
	graders: [
		tracePredicate(
			"compaction-occurred",
			(ctx) => {
				const path = join(ctx.dotDir, "conversations/dm-1/context.jsonl");
				return (
					existsSync(path) &&
					readFileSync(path, "utf8")
						.split("\n")
						.filter(Boolean)
						.some((line) => {
							const entry = JSON.parse(line);
							return entry.type === "compaction" && entry.details?.background === true;
						})
				);
			},
			"a background candidate must actually be persisted before the continuation",
		),
		manualCheckpoint.graders[1]!,
		tracePredicate(
			"artifact-written-after-checkpoint",
			(ctx) =>
				ctx.trace.some(
					(event) =>
						event.kind === "tool-call" &&
						event.stepIndex! >= 2 &&
						JSON.stringify(event.fields ?? {}).includes("handoff.json") &&
						["write", "edit", "bash"].includes(event.tool ?? ""),
				),
			"an artifact written before compression cannot establish checkpoint recall",
		),
	],
});
