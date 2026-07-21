import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	CompactionResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
	SessionStats,
} from "@earendil-works/pi-coding-agent";
import { basename } from "path";
import { findModelReferenceMatch, formatModelList, formatModelReference } from "../models/utils.js";
import { sessionCommandDescription } from "./commands.js";

export const COMMAND_RESULT_CUSTOM_TYPE = "pipiclaw.command_result";

export interface PipiclawCommandExtensionOptions {
	getCurrentModel: () => Model<Api> | undefined;
	getAvailableModels: () => Promise<Model<Api>[]>;
	getSessionStats: () => SessionStats;
	getThinkingLevel: () => ThinkingLevel;
	getAvailableThinkingLevels: () => ThinkingLevel[];
	setThinkingLevel: (level: ThinkingLevel) => void;
	cycleThinkingLevel: () => ThinkingLevel | undefined;
	getLastResponseModel?: () => string | undefined;
	switchModel: (model: Model<Api>) => Promise<void>;
	refreshSessionResources: () => Promise<void>;
	runMemoryCommand: (args: string) => Promise<string>;
}

function buildSessionText(
	stats: SessionStats,
	currentModel: Model<Api> | undefined,
	thinkingLevel: ThinkingLevel,
	lastResponseModel?: string,
): string {
	const configuredRef = currentModel ? formatModelReference(currentModel) : null;
	const modelText = configuredRef ? `\`${configuredRef}\`` : "(none)";
	const actualText =
		lastResponseModel && configuredRef && lastResponseModel !== configuredRef
			? ` (actual: \`${lastResponseModel}\`)`
			: "";
	const sessionFile = stats.sessionFile ? `\`${basename(stats.sessionFile)}\`` : "(none)";
	return `# Session

- Session ID: \`${stats.sessionId}\`
- Session file: ${sessionFile}
- Model: ${modelText}${actualText}
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

type CommandMessageSender = {
	sendMessage: (
		message: Parameters<ExtensionAPI["sendMessage"]>[0],
		options?: Parameters<ExtensionAPI["sendMessage"]>[1],
	) => void | Promise<void>;
};

function sendCommandResult(sender: CommandMessageSender, text: string): void | Promise<void> {
	return sender.sendMessage({
		customType: COMMAND_RESULT_CUSTOM_TYPE,
		content: text,
		display: true,
	});
}

function buildThinkingText(current: ThinkingLevel, available: ThinkingLevel[]): string {
	return `# Thinking

Current level: \`${current}\`
Available levels: ${available.map((level) => `\`${level}\``).join(", ")}

Use \`/thinking <level>\` to set a level, or \`/thinking cycle\` to select the next supported level.`;
}

export function createCommandExtension(options: PipiclawCommandExtensionOptions): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("memory", {
			description: sessionCommandDescription("memory"),
			handler: async (args) => {
				sendCommandResult(pi, await options.runMemoryCommand(args));
			},
		});

		pi.registerCommand("session", {
			description: sessionCommandDescription("session"),
			handler: async () => {
				sendCommandResult(
					pi,
					buildSessionText(
						options.getSessionStats(),
						options.getCurrentModel(),
						options.getThinkingLevel(),
						options.getLastResponseModel?.(),
					),
				);
			},
		});

		pi.registerCommand("thinking", {
			description: sessionCommandDescription("thinking"),
			handler: async (args) => {
				const available = options.getAvailableThinkingLevels();
				const normalized = args.trim().toLowerCase();

				if (!normalized) {
					sendCommandResult(pi, buildThinkingText(options.getThinkingLevel(), available));
					return;
				}

				if (normalized === "cycle") {
					const next = options.cycleThinkingLevel();
					if (!next) {
						sendCommandResult(pi, "当前模型不支持 thinking/reasoning。");
						return;
					}
					sendCommandResult(pi, `Thinking level 已切换为 \`${next}\`。`);
					return;
				}

				if (!available.includes(normalized as ThinkingLevel)) {
					sendCommandResult(
						pi,
						`不支持 thinking level \`${args.trim()}\`。当前模型可用值：${available
							.map((level) => `\`${level}\``)
							.join(", ")}`,
					);
					return;
				}

				const level = normalized as ThinkingLevel;
				options.setThinkingLevel(level);
				sendCommandResult(pi, `Thinking level 已设置为 \`${level}\`。`);
			},
		});

		pi.registerCommand("model", {
			description: sessionCommandDescription("model"),
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
			description: sessionCommandDescription("new"),
			handler: async (_args, ctx) => {
				let sentFromReplacement = false;
				const result = await ctx.newSession({
					withSession: async (nextCtx) => {
						sentFromReplacement = true;
						await options.refreshSessionResources();
						await sendCommandResult(
							nextCtx,
							`已开启新会话。\n\nSession ID: \`${nextCtx.sessionManager.getSessionId()}\``,
						);
					},
				});
				if (result.cancelled) {
					sendCommandResult(pi, "新会话已取消。");
				} else if (!sentFromReplacement) {
					await options.refreshSessionResources();
					sendCommandResult(pi, `已开启新会话。\n\nSession ID: \`${ctx.sessionManager.getSessionId()}\``);
				}
			},
		});

		pi.registerCommand("compact", {
			description: sessionCommandDescription("compact"),
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
