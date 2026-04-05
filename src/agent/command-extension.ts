import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
	SessionStats,
} from "@mariozechner/pi-coding-agent";
import { basename } from "path";
import { findModelReferenceMatch, formatModelList, formatModelReference } from "../models/utils.js";

export const COMMAND_RESULT_CUSTOM_TYPE = "pipiclaw.command_result";

export interface PipiclawCommandExtensionOptions {
	getCurrentModel: () => Model<Api> | undefined;
	getAvailableModels: () => Promise<Model<Api>[]>;
	getSessionStats: () => SessionStats;
	getThinkingLevel: () => ThinkingLevel;
	switchModel: (model: Model<Api>) => Promise<void>;
	refreshSessionResources: () => Promise<void>;
}

function buildSessionText(
	stats: SessionStats,
	currentModel: Model<Api> | undefined,
	thinkingLevel: ThinkingLevel,
): string {
	const modelText = currentModel ? `\`${formatModelReference(currentModel)}\`` : "(none)";
	const sessionFile = stats.sessionFile ? `\`${basename(stats.sessionFile)}\`` : "(none)";
	return `# Session

- Session ID: \`${stats.sessionId}\`
- Session file: ${sessionFile}
- Model: ${modelText}
- Thinking level: \`${thinkingLevel}\`
- User messages: \`${stats.userMessages}\`
- Assistant messages: \`${stats.assistantMessages}\`
- Tool calls: \`${stats.toolCalls}\`
- Tool results: \`${stats.toolResults}\`
- Total messages: \`${stats.totalMessages}\`
- Tokens: \`${stats.tokens.total}\` (input \`${stats.tokens.input}\`, output \`${stats.tokens.output}\`, cache read \`${stats.tokens.cacheRead}\`, cache write \`${stats.tokens.cacheWrite}\`)
- Cost: \`$${stats.cost.toFixed(4)}\``;
}

async function runCompact(
	ctx: ExtensionCommandContext,
	customInstructions: string | undefined,
): Promise<CompactionResult> {
	return await new Promise<CompactionResult>((resolve, reject) => {
		ctx.compact({
			customInstructions,
			onComplete: resolve,
			onError: reject,
		});
	});
}

function sendCommandResult(pi: Pick<ExtensionAPI, "sendMessage">, text: string): void {
	pi.sendMessage({
		customType: COMMAND_RESULT_CUSTOM_TYPE,
		content: text,
		display: true,
	});
}

export function createCommandExtension(options: PipiclawCommandExtensionOptions): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("session", {
			description: "Show current session state, usage, and model info",
			handler: async () => {
				sendCommandResult(
					pi,
					buildSessionText(options.getSessionStats(), options.getCurrentModel(), options.getThinkingLevel()),
				);
			},
		});

		pi.registerCommand("model", {
			description: "Show the current model or switch models using an exact or uniquely matching substring",
			handler: async (args) => {
				const availableModels = await options.getAvailableModels();
				const currentModel = options.getCurrentModel();

				if (!args.trim()) {
					const current = currentModel ? `\`${formatModelReference(currentModel)}\`` : "(none)";
					const available =
						availableModels.length > 0 ? formatModelList(availableModels, currentModel) : "- (none)";
					sendCommandResult(
						pi,
						`# Model

Current model: ${current}

Use \`/model <provider/modelId>\`, \`/model <modelId>\`, or any uniquely matching substring to switch.

Available models:
${available}`,
					);
					return;
				}

				const match = findModelReferenceMatch(args, availableModels);
				const available =
					availableModels.length > 0 ? formatModelList(availableModels, currentModel, 10) : "- (none)";

				if (match.match) {
					await options.switchModel(match.match);
					sendCommandResult(pi, `已切换模型到 \`${formatModelReference(match.match)}\`.`);
					return;
				}

				if (match.ambiguous) {
					sendCommandResult(
						pi,
						`未切换模型：\`${args.trim()}\` 匹配到多个模型。请提供更精确的 \`provider/modelId\`、\`modelId\` 或更长的片段。

Available models:
${available}`,
					);
					return;
				}

				sendCommandResult(
					pi,
					`未找到模型 \`${args.trim()}\`。请使用精确的 \`provider/modelId\`、唯一的 \`modelId\`，或能唯一命中的片段字符串。

Available models:
${available}`,
				);
			},
		});

		pi.registerCommand("new", {
			description: "Start a new session",
			handler: async (_args, ctx) => {
				const result = await ctx.newSession();
				if (!result.cancelled) {
					await options.refreshSessionResources();
				}
				sendCommandResult(
					pi,
					result.cancelled
						? "新会话已取消。"
						: `已开启新会话。\n\nSession ID: \`${ctx.sessionManager.getSessionId()}\``,
				);
			},
		});

		pi.registerCommand("compact", {
			description: "Manually compact the current session context",
			handler: async (args, ctx) => {
				const customInstructions = args.trim() || undefined;
				const result = await runCompact(ctx, customInstructions);
				sendCommandResult(
					pi,
					`已压缩当前会话上下文。

- Tokens before compaction: \`${result.tokensBefore}\`
- Summary:

\`\`\`text
${result.summary}
\`\`\``,
				);
			},
		});
	};
}
