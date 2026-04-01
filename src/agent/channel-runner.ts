import { Agent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	type SettingsManager as SDKSettingsManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { createCommandExtension } from "../command-extension.js";
import { type BuiltInCommand, renderBuiltInHelp } from "../commands.js";
import { getAgentConfig, getApiKeyForModel, getSoul, loadPipiclawSkills } from "../config-loader.js";
import { PipiclawSettingsManager } from "../context.js";
import type { DingTalkContext } from "../dingtalk.js";
import * as log from "../log.js";
import { createMemoryCandidateCache } from "../memory-candidates.js";
import { MemoryLifecycle } from "../memory-lifecycle.js";
import { recallRelevantMemory } from "../memory-recall.js";
import { resolveInitialModel } from "../model-utils.js";
import { APP_HOME_DIR, AUTH_CONFIG_PATH, MODELS_CONFIG_PATH } from "../paths.js";
import { buildAppendSystemPrompt } from "../prompt-builder.js";
import { createExecutor, type SandboxConfig } from "../sandbox.js";
import { extractLabelFromArgs, HAN_REGEX, truncate } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { UsageTotals } from "../shared/types.js";
import type { ChannelStore } from "../store.js";
import { discoverSubAgents, formatSubAgentList, type SubAgentDiscoveryResult } from "../sub-agents.js";
import { createPipiclawTools } from "../tools/index.js";
import { clipUserInput } from "./progress-formatter.js";
import { createRunQueue } from "./run-queue.js";
import { handleSessionEvent } from "./session-events.js";
import { getLastAssistantUsage } from "./type-guards.js";
import {
	createEmptyRunState,
	MAX_USER_MESSAGE_CHARS,
	type AgentRunner,
	type FinalOutcome,
	type RunState,
} from "./types.js";

type ModelRegistryClass = {
	create?: (authStorage: AuthStorage, modelsJsonPath?: string) => ModelRegistry;
	new (authStorage: AuthStorage, modelsJsonPath?: string): ModelRegistry;
};

function isSilentOutcome(outcome: FinalOutcome): outcome is { kind: "silent" } {
	return outcome.kind === "silent";
}

function isFinalOutcome(outcome: FinalOutcome): outcome is { kind: "final"; text: string } {
	return outcome.kind === "final";
}

function getFinalOutcomeText(outcome: FinalOutcome): string | null {
	return isFinalOutcome(outcome) ? outcome.text : null;
}

function createModelRegistry(authStorage: AuthStorage, modelsJsonPath: string): ModelRegistry {
	const registryClass = ModelRegistry as unknown as ModelRegistryClass;
	return typeof registryClass.create === "function"
		? registryClass.create(authStorage, modelsJsonPath)
		: new registryClass(authStorage, modelsJsonPath);
}

function asSdkSettingsManager(manager: PipiclawSettingsManager): SDKSettingsManager {
	return manager as unknown as SDKSettingsManager;
}
export class ChannelRunner implements AgentRunner {
	// --- Constructed once ---
	private readonly sandboxConfig: SandboxConfig;
	private readonly channelId: string;
	private readonly channelDir: string;
	private readonly workspacePath: string;
	private readonly workspaceDir: string;
	private readonly session: AgentSession;
	private readonly agent: Agent;
	private readonly sessionManager: SessionManager;
	private readonly settingsManager: PipiclawSettingsManager;
	private readonly modelRegistry: ModelRegistry;
	private readonly memoryLifecycle: MemoryLifecycle;
	private readonly sessionReady: Promise<void>;
	private subAgentDiscovery: SubAgentDiscoveryResult;

	// --- Mutable across runs ---
	private activeModel: Model<Api>;
	private currentSkills: Skill[];

	// --- Per run ---
	private runState: RunState = createEmptyRunState();

	constructor(sandboxConfig: SandboxConfig, channelId: string, channelDir: string) {
		this.sandboxConfig = sandboxConfig;
		this.channelId = channelId;
		this.channelDir = channelDir;

		const executor = createExecutor(sandboxConfig);
		this.workspaceDir = resolve(dirname(channelDir));
		this.workspacePath = executor.getWorkspacePath(this.workspaceDir);

		// Initial skill summaries
		const initialSkills = loadPipiclawSkills(channelDir, this.workspacePath);
		this.currentSkills = initialSkills;

		// Create session manager
		const contextFile = join(channelDir, "context.jsonl");
		this.sessionManager = SessionManager.open(contextFile, channelDir);
		this.settingsManager = new PipiclawSettingsManager(APP_HOME_DIR);

		// Create AuthStorage and ModelRegistry
		const authStorage = AuthStorage.create(AUTH_CONFIG_PATH);
		this.modelRegistry = createModelRegistry(authStorage, MODELS_CONFIG_PATH);

		// Resolve model: prefer saved global default, fall back to first available model
		this.activeModel = resolveInitialModel(this.modelRegistry, this.settingsManager);
		log.logInfo(`Using model: ${this.activeModel.provider}/${this.activeModel.id} (${this.activeModel.name})`);
		this.subAgentDiscovery = this.refreshSubAgentDiscovery();

		// Create tools
		const tools = createPipiclawTools({
			executor,
			getCurrentModel: () => this.activeModel,
			getAvailableModels: () => this.modelRegistry.getAvailable(),
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			workspaceDir: this.workspaceDir,
			channelDir: this.channelDir,
			workspacePath: this.workspacePath,
			channelId: this.channelId,
			sandboxConfig: this.sandboxConfig,
			getSubAgentDiscovery: () => this.subAgentDiscovery,
			getMemoryRecallSettings: () => this.settingsManager.getMemoryRecallSettings(),
		});

		// Create agent
		this.agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: this.activeModel,
				thinkingLevel: "off",
				tools,
			},
			convertToLlm,
			getApiKey: async () => getApiKeyForModel(this.modelRegistry, this.activeModel),
		});

		this.memoryLifecycle = new MemoryLifecycle({
			channelId: this.channelId,
			channelDir: this.channelDir,
			getMessages: () => this.session.messages,
			getSessionEntries: () => this.sessionManager.getBranch(),
			getModel: () => this.session.model ?? this.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			getSessionMemorySettings: () => this.settingsManager.getSessionMemorySettings(),
		});

			const resourceLoader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: APP_HOME_DIR,
				settingsManager: asSdkSettingsManager(this.settingsManager),
			extensionFactories: [
				this.memoryLifecycle.createExtensionFactory(),
				createCommandExtension({
					getCurrentModel: () => this.session.model ?? this.activeModel,
					getAvailableModels: async () => {
						this.modelRegistry.refresh();
						return await this.modelRegistry.getAvailable();
					},
					getSessionStats: () => this.session.getSessionStats(),
					getThinkingLevel: () => this.session.thinkingLevel,
					switchModel: async (model) => {
						await this.session.setModel(model);
						this.activeModel = model;
					},
					refreshSessionResources: async () => {
						await this.refreshSessionResources();
					},
				}),
			],
			appendSystemPromptOverride: (base) => {
				const soul = getSoul(this.workspaceDir);
				const sections = [...base];
				if (soul) {
					sections.unshift(soul);
				}
				sections.push(
					buildAppendSystemPrompt(this.workspacePath, this.channelId, this.sandboxConfig, {
						subAgentList: formatSubAgentList(this.subAgentDiscovery.agents),
					}),
				);
				return sections;
			},
			agentsFilesOverride: () => {
				const agentConfig = getAgentConfig(this.channelDir);
				return {
					agentsFiles: agentConfig ? [{ path: `${this.workspacePath}/AGENTS.md`, content: agentConfig }] : [],
				};
			},
			skillsOverride: (base) => ({
				skills: [...base.skills, ...this.currentSkills],
				diagnostics: base.diagnostics,
			}),
		});

		const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

		// Create AgentSession
			this.session = new AgentSession({
				agent: this.agent,
				sessionManager: this.sessionManager,
				settingsManager: asSdkSettingsManager(this.settingsManager),
			cwd: process.cwd(),
			modelRegistry: this.modelRegistry,
			resourceLoader,
			baseToolsOverride,
		});

		// Subscribe to session events
		this.subscribeToSessionEvents();
		this.sessionReady = this.initializeSession();
	}

	// === Public API ===

	async run(ctx: DingTalkContext, store: ChannelStore): Promise<{ stopReason: string; errorMessage?: string }> {
		this.resetRunState(ctx, store);

		const runQueue = createRunQueue(ctx);
		this.runState.queue = runQueue.queue;

		try {
			await this.ensureSessionReady();

			// Ensure channel directory exists
			await mkdir(this.channelDir, { recursive: true });

			const candidateCache = createMemoryCandidateCache();
			const clippedInput = clipUserInput(ctx.message.text, MAX_USER_MESSAGE_CHARS);
			const userMessage = this.formatUserMessage(clippedInput, ctx.message.userName);
			let promptText = this.shouldPreserveRawInput(ctx.message.text) ? clippedInput : userMessage;
			let recalledContextText = "";

			if (!this.shouldPreserveRawInput(ctx.message.text)) {
				const recallSettings = this.settingsManager.getMemoryRecallSettings();
				if (recallSettings.enabled) {
					const recall = await recallRelevantMemory({
						query: clippedInput,
						workspaceDir: this.workspaceDir,
						channelDir: this.channelDir,
						maxCandidates: recallSettings.maxCandidates,
						maxInjected: recallSettings.maxInjected,
						maxChars: recallSettings.maxChars,
						rerankWithModel: recallSettings.rerankWithModel,
						autoRerank: HAN_REGEX.test(clippedInput),
						model: this.session.model ?? this.activeModel,
						resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
						candidateCache,
					});

					if (recall.renderedText) {
						recalledContextText = recall.renderedText;
						promptText = `${recall.renderedText}\n\n<user_message>\n${promptText}\n</user_message>`;
					}
				}
			}

			// Debug: write context to last_prompt.json (only with PIPICLAW_DEBUG=1)
			if (process.env.PIPICLAW_DEBUG) {
				const debugContext = {
					systemPrompt: this.agent.state.systemPrompt,
					messages: this.session.messages,
					recalledContext: recalledContextText || undefined,
					newUserMessage: promptText,
				};
				await writeFile(join(this.channelDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2));
			}

			await this.session.prompt(promptText);
		} catch (err) {
			this.runState.stopReason = "error";
			this.runState.errorMessage = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${this.channelId}] Runner failed`, this.runState.errorMessage);
		} finally {
			await runQueue.drain();
			const finalOutcome = this.runState.finalOutcome;
			const finalOutcomeText = getFinalOutcomeText(finalOutcome);

			try {
				if (
					this.runState.stopReason === "error" &&
					this.runState.errorMessage &&
					!this.runState.finalResponseDelivered
				) {
					try {
						await ctx.replaceMessage("_Sorry, something went wrong_");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to post error message", errMsg);
					}
				} else if (isSilentOutcome(finalOutcome)) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalOutcomeText && !this.runState.finalResponseDelivered) {
					try {
						await ctx.replaceMessage(finalOutcomeText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}

				await ctx.flush();
			} finally {
				await ctx.close();
			}

			// Log usage summary
			if (this.runState.totalUsage.cost.total > 0) {
				const lastAssistantMessage = getLastAssistantUsage(this.session.messages);

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const currentRunModel = this.session.model ?? this.activeModel;
				const contextWindow = currentRunModel.contextWindow || 200000;

				log.logUsageSummary(this.runState.logCtx!, this.runState.totalUsage, contextTokens, contextWindow);
			}

			// Clear run state
			this.runState.ctx = null;
			this.runState.logCtx = null;
			this.runState.queue = null;
		}

		return { stopReason: this.runState.stopReason, errorMessage: this.runState.errorMessage };
	}

	async handleBuiltinCommand(ctx: DingTalkContext, command: BuiltInCommand): Promise<void> {
		try {
			switch (command.name) {
				case "help":
					await this.sendCommandReply(ctx, renderBuiltInHelp());
					return;
				case "stop":
					await this.sendCommandReply(ctx, "No task is running. Use `/stop` only while a task is running.");
					return;
				case "steer":
					this.requireQueuedMessage(command.args, "steer");
					await this.sendCommandReply(
						ctx,
						"No task is running. Send the message directly instead of using `/steer`.",
					);
					return;
				case "followup":
					this.requireQueuedMessage(command.args, "followup");
					await this.sendCommandReply(
						ctx,
						"No task is running. Send the message directly now, or use `/followup` while a task is running.",
					);
					return;
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${this.channelId}] Built-in command failed`, errMsg);
			await this.sendCommandReply(ctx, `命令执行失败：${errMsg}`);
		}
	}

	async queueSteer(text: string, userName?: string): Promise<void> {
		await this.queueBusyMessage("steer", this.requireQueuedMessage(text, "steer"), userName);
	}

	async queueFollowUp(text: string, userName?: string): Promise<void> {
		await this.queueBusyMessage("followUp", this.requireQueuedMessage(text, "followup"), userName);
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	// === Private helpers ===

	private async sendCommandReply(ctx: DingTalkContext, text: string): Promise<void> {
		const delivered = await ctx.respondPlain(text);
		if (!delivered) {
			await ctx.replaceMessage(text);
			await ctx.flush();
		}
	}

	private requireQueuedMessage(text: string, commandName: "steer" | "followup"): string {
		const trimmedText = text.trim();
		if (!trimmedText) {
			throw new Error(`/${commandName} requires a message.`);
		}
		return trimmedText;
	}

	private shouldPreserveRawInput(text: string): boolean {
		return text.trim().startsWith("/");
	}

	private formatUserMessage(text: string, userName?: string, now: Date = new Date()): string {
		const pad = (n: number) => n.toString().padStart(2, "0");
		const offset = -now.getTimezoneOffset();
		const offsetSign = offset >= 0 ? "+" : "-";
		const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
		const offsetMins = pad(Math.abs(offset) % 60);
		const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
		return `[${timestamp}] [${userName || "unknown"}]: ${text}`;
	}

	private async queueBusyMessage(delivery: "steer" | "followUp", text: string, userName?: string): Promise<void> {
		if (!this.session.isStreaming) {
			throw new Error("No task is currently running.");
		}

		const clippedText = clipUserInput(text, MAX_USER_MESSAGE_CHARS);
		if (clippedText !== text.trim()) {
			log.logWarning(`[${this.channelId}] Queued message exceeded ${MAX_USER_MESSAGE_CHARS} chars and was clipped`);
		}

		await this.session.prompt(this.formatUserMessage(clippedText, userName), {
			streamingBehavior: delivery,
		});
	}

	private resetRunState(ctx: DingTalkContext, store: ChannelStore): void {
		this.runState = createEmptyRunState();
		this.runState.ctx = ctx;
		this.runState.logCtx = {
			channelId: ctx.message.channel,
			userName: ctx.message.userName,
			channelName: ctx.channelName,
		};
		this.runState.store = store;
	}

	private async refreshSessionResources(): Promise<void> {
		await this.ensureSessionReady();
		const skills = loadPipiclawSkills(this.channelDir, this.workspacePath);
		this.currentSkills = skills;
		this.subAgentDiscovery = this.refreshSubAgentDiscovery();
		await this.session.reload();
	}

	private async initializeSession(): Promise<void> {
		const skills = loadPipiclawSkills(this.channelDir, this.workspacePath);
		this.currentSkills = skills;
		this.subAgentDiscovery = this.refreshSubAgentDiscovery();
		await this.session.reload();
	}

	private async ensureSessionReady(): Promise<void> {
		await this.sessionReady;
	}

	private refreshSubAgentDiscovery(): SubAgentDiscoveryResult {
		this.modelRegistry.refresh();
		const discovery = discoverSubAgents(this.workspaceDir, this.modelRegistry.getAvailable());
		for (const warning of discovery.warnings) {
			log.logWarning(`Sub-agent config warning (${this.channelId})`, warning);
		}
		return discovery;
	}

	// === Session event subscription ===

	private subscribeToSessionEvents(): void {
		this.session.subscribe(async (event: unknown) => {
			if (!this.runState.ctx || !this.runState.logCtx || !this.runState.queue) return;
			await handleSessionEvent(event, {
				ctx: this.runState.ctx,
				logCtx: this.runState.logCtx,
				queue: this.runState.queue,
				pendingTools: this.runState.pendingTools,
				store: this.runState.store,
				runState: this.runState,
				memoryLifecycle: this.memoryLifecycle,
			});
		});
	}
}
