import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	ModelRegistry,
	type SettingsManager as SDKSettingsManager,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import * as log from "../log.js";
import { buildFirstTurnMemoryBootstrap as renderFirstTurnMemoryBootstrap } from "../memory/bootstrap.js";
import { createMemoryCandidateStore, type MemoryCandidateStore } from "../memory/candidates.js";
import { getChannelMemoryPath } from "../memory/files.js";
import { MemoryLifecycle } from "../memory/lifecycle.js";
import {
	applyMemoryActivityToState,
	type MemoryActivityEvent,
	updateMemoryMaintenanceState,
} from "../memory/maintenance-state.js";
import { recallRelevantMemory } from "../memory/recall.js";
import type { MemoryMaintenanceRuntimeContext } from "../memory/scheduler.js";
import { getApiKeyForModel } from "../models/api-keys.js";
import { resolveInitialModel } from "../models/utils.js";
import { APP_HOME_DIR, AUTH_CONFIG_PATH, MODELS_CONFIG_PATH } from "../paths.js";
import type { DingTalkContext } from "../runtime/dingtalk.js";
import type { ChannelStore } from "../runtime/store.js";
import { createExecutor, type Executor, type SandboxConfig } from "../sandbox.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { PipiclawSettingsManager } from "../settings.js";
import { type ConfigDiagnostic, formatConfigDiagnostic } from "../shared/config-diagnostics.js";
import { HAN_REGEX } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { discoverSubAgents, formatSubAgentList, type SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { loadToolsConfigWithDiagnostics } from "../tools/config.js";
import { createPipiclawTools } from "../tools/index.js";
import { createCommandExtension } from "./command-extension.js";
import { type BuiltInCommand, renderBuiltInHelp } from "./commands.js";
import { estimateIncomingMessageTokens, getPreventiveCompactionDecision } from "./context-budget.js";
import { clipUserInput } from "./progress-formatter.js";
import { buildAppendSystemPrompt } from "./prompt-builder.js";
import { createRunQueue } from "./run-queue.js";
import { handleSessionEvent } from "./session-events.js";
import { SessionResourceGate } from "./session-resource-gate.js";
import { getLastAssistantUsage } from "./type-guards.js";
import {
	type AgentRunner,
	createEmptyRunState,
	type FinalOutcome,
	MAX_USER_MESSAGE_CHARS,
	type RunState,
} from "./types.js";
import { getAgentConfig, getSoul, loadPipiclawSkills } from "./workspace-resources.js";

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
	private readonly executor: Executor;
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
	private readonly memoryCandidateStore: MemoryCandidateStore;
	private readonly sessionResourceGate: SessionResourceGate;
	private readonly sessionReady: Promise<void>;
	private subAgentDiscovery: SubAgentDiscoveryResult;

	// --- Mutable across runs ---
	private activeModel: Model<Api>;
	private currentSkills: Skill[];
	private firstTurnMemoryBootstrapPending = true;

	// --- Per run ---
	private runState: RunState = createEmptyRunState();

	constructor(sandboxConfig: SandboxConfig, channelId: string, channelDir: string) {
		this.sandboxConfig = sandboxConfig;
		this.channelId = channelId;
		this.channelDir = channelDir;

		const executor = createExecutor(sandboxConfig);
		this.executor = executor;
		this.workspaceDir = resolve(dirname(channelDir));
		this.workspacePath = executor.getWorkspacePath(this.workspaceDir);

		// Initial skill summaries
		const initialSkills = loadPipiclawSkills(channelDir, this.workspacePath);
		this.currentSkills = initialSkills;

		// Create session manager
		const contextFile = join(channelDir, "context.jsonl");
		this.sessionManager = SessionManager.open(contextFile, channelDir);
		this.settingsManager = new PipiclawSettingsManager(APP_HOME_DIR);
		this.reportSettingsDiagnostics();
		this.memoryCandidateStore = createMemoryCandidateStore();

		// Create AuthStorage and ModelRegistry
		const authStorage = AuthStorage.create(AUTH_CONFIG_PATH);
		this.modelRegistry = createModelRegistry(authStorage, MODELS_CONFIG_PATH);

		// Resolve model: prefer saved global default, fall back to first available model
		this.activeModel = resolveInitialModel(this.modelRegistry, this.settingsManager);
		log.logInfo(`Using model: ${this.activeModel.provider}/${this.activeModel.id} (${this.activeModel.name})`);
		this.subAgentDiscovery = this.refreshSubAgentDiscovery();

		// Create tools
		const tools = this.buildRuntimeTools();

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
			getMemoryGrowthSettings: () => this.settingsManager.getMemoryGrowthSettings(),
			getWorkspaceDir: () => this.workspaceDir,
			getWorkspacePath: () => this.workspacePath,
			getLoadedSkills: () =>
				this.currentSkills.map((skill) => ({
					name: skill.name,
					description: skill.description,
				})),
			emitNotice: async (notice) => {
				if (!this.runState.ctx) {
					return;
				}
				await this.runState.ctx.respondInThread(notice);
			},
			refreshWorkspaceResources: async () => {
				await this.refreshSessionResources();
			},
			recordMemoryActivity: (event) => {
				void this.recordMemoryActivity(event);
			},
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
		this.sessionResourceGate = new SessionResourceGate(async () => {
			await this.reloadSessionResources();
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
			this.memoryLifecycle.noteUserTurnStarted();
			const clippedInput = clipUserInput(ctx.message.text, MAX_USER_MESSAGE_CHARS);
			const userMessage = this.formatUserMessage(clippedInput, ctx.message.userName);
			const preserveRawInput = this.shouldPreserveRawInput(ctx.message.text);
			await this.maybeRunPreventiveCompactionForIncomingText(preserveRawInput ? clippedInput : userMessage);

			// Ensure channel directory exists
			await mkdir(this.channelDir, { recursive: true });

			let promptText = preserveRawInput ? clippedInput : userMessage;
			let recalledContextText = "";
			let durableMemoryBootstrapText = "";

			if (!preserveRawInput) {
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
						candidateStore: this.memoryCandidateStore,
					});

					if (recall.renderedText) {
						recalledContextText = recall.renderedText;
						promptText = `${recall.renderedText}\n\n<user_message>\n${promptText}\n</user_message>`;
					}
				}

				if (this.firstTurnMemoryBootstrapPending) {
					durableMemoryBootstrapText = await this.buildFirstTurnMemoryBootstrap();
					if (durableMemoryBootstrapText) {
						promptText = `${durableMemoryBootstrapText}\n\n${promptText}`;
					}
					this.firstTurnMemoryBootstrapPending = false;
				}
			}

			// Debug: write context to last_prompt.json (only with PIPICLAW_DEBUG=1)
			if (process.env.PIPICLAW_DEBUG) {
				const debugContext = {
					systemPrompt: this.agent.state.systemPrompt,
					messages: this.session.messages,
					durableMemoryBootstrap: durableMemoryBootstrapText || undefined,
					recalledContext: recalledContextText || undefined,
					newUserMessage: promptText,
				};
				await writeFile(join(this.channelDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2));
			}

			await this.sessionResourceGate.runPrompt(async () => {
				await this.session.prompt(promptText);
			});
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
						const baseErrorSummary =
							this.runState.errorMessage.length > 240
								? `${this.runState.errorMessage.slice(0, 237)}...`
								: this.runState.errorMessage;
						const compactionSummary =
							this.runState.lastCompactionError &&
							this.runState.lastCompactionError !== this.runState.errorMessage
								? this.runState.lastCompactionError.length > 240
									? `${this.runState.lastCompactionError.slice(0, 237)}...`
									: this.runState.lastCompactionError
								: undefined;
						const detailLines = [`\`${baseErrorSummary}\``];
						if (compactionSummary) {
							detailLines.push(`Recovery: \`${compactionSummary}\``);
						}
						await ctx.replaceMessage(`_Sorry, something went wrong._\n\n${detailLines.join("\n\n")}`);
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
				} else if (this.runState.stopReason === "aborted" && !this.runState.finalResponseDelivered) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Aborted response - discarded active delivery state");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to discard active delivery state after abort", errMsg);
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

	async flushMemoryForShutdown(): Promise<void> {
		await this.memoryLifecycle.flushForShutdown();
	}

	async getMemoryMaintenanceContext(): Promise<MemoryMaintenanceRuntimeContext> {
		await this.ensureSessionReady();
		this.settingsManager.reload();
		return {
			channelId: this.channelId,
			channelDir: this.channelDir,
			workspaceDir: this.workspaceDir,
			workspacePath: this.workspacePath,
			messages: [...this.session.messages],
			sessionEntries: [...this.sessionManager.getBranch()],
			model: this.session.model ?? this.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			settings: {
				sessionMemory: this.settingsManager.getSessionMemorySettings(),
				memoryGrowth: this.settingsManager.getMemoryGrowthSettings(),
				memoryMaintenance: this.settingsManager.getMemoryMaintenanceSettings(),
			},
			loadedSkills: this.currentSkills.map((skill) => ({
				name: skill.name,
				description: skill.description,
			})),
			refreshWorkspaceResources: async () => {
				await this.refreshSessionResources();
			},
		};
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

	private async recordMemoryActivity(event: MemoryActivityEvent): Promise<void> {
		const maintenanceSettings = this.settingsManager.getMemoryMaintenanceSettings();
		const eventTime = Date.parse(event.timestamp);
		const eligibleAfter = Number.isFinite(eventTime)
			? new Date(eventTime + Math.max(0, maintenanceSettings.minIdleMinutesBeforeLlmWork) * 60_000).toISOString()
			: undefined;
		try {
			await updateMemoryMaintenanceState(APP_HOME_DIR, this.channelId, (state) =>
				applyMemoryActivityToState(state, {
					...event,
					eligibleAfter,
				}),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.channelId}] Failed to record memory maintenance state`, message);
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
		const queuedMessage = this.formatUserMessage(clippedText, userName);
		await this.maybeRunPreventiveCompactionForIncomingText(queuedMessage);

		await this.sessionResourceGate.runPrompt(async () => {
			await this.session.prompt(queuedMessage, {
				streamingBehavior: delivery,
			});
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
		await this.sessionResourceGate.requestRefresh();
	}

	private async initializeSession(): Promise<void> {
		await this.reloadSessionResources();
		await this.bindSessionExtensions();
	}

	private async reloadSessionResources(): Promise<void> {
		this.settingsManager.reload();
		this.reportSettingsDiagnostics();
		const skills = loadPipiclawSkills(this.channelDir, this.workspacePath);
		this.currentSkills = skills;
		this.subAgentDiscovery = this.refreshSubAgentDiscovery();
		this.rebuildSessionTools();
		await this.session.reload();
	}

	private async bindSessionExtensions(): Promise<void> {
		await this.session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => this.session.agent.waitForIdle(),
				newSession: async (options) => {
					const success = await this.session.newSession(options);
					return { cancelled: !success };
				},
				fork: async (entryId) => {
					const result = await this.session.fork(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath) => {
					const success = await this.session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await this.refreshSessionResources();
				},
			},
		});
	}

	private async ensureSessionReady(): Promise<void> {
		await this.sessionReady;
	}

	private async maybeRunPreventiveCompactionForIncomingText(incomingText: string): Promise<void> {
		const currentModel = this.session.model ?? this.activeModel;
		const contextUsage = this.session.getContextUsage();
		const contextTokens = contextUsage?.tokens;
		const incomingTokens = estimateIncomingMessageTokens(incomingText);
		const decision = getPreventiveCompactionDecision(contextTokens, incomingTokens, currentModel.contextWindow);

		if (!decision.shouldCompact) {
			return;
		}

		const currentTokens = contextTokens ?? 0;
		const startedAt = Date.now();
		log.logInfo(
			`[${this.channelId}] Preventive compaction triggered: projected ${decision.projectedTokens}/${currentModel.contextWindow} tokens (current=${currentTokens}, incoming≈${incomingTokens}), threshold=${decision.thresholdTokens}`,
		);

		try {
			await this.session.compact();
			log.logInfo(`[${this.channelId}] Preventive compaction complete in ${Date.now() - startedAt}ms`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.logWarning(`[${this.channelId}] Preventive compaction failed`, message);
		}
	}

	private refreshSubAgentDiscovery(): SubAgentDiscoveryResult {
		this.modelRegistry.refresh();
		const discovery = discoverSubAgents(this.workspaceDir, this.modelRegistry.getAvailable());
		for (const warning of discovery.warnings) {
			log.logWarning(`Sub-agent config warning (${this.channelId})`, warning);
		}
		return discovery;
	}

	private reportSettingsDiagnostics(): void {
		for (const { scope, error } of this.settingsManager.drainErrors()) {
			log.logWarning(
				`[${this.channelId}] Failed to load ${scope} settings`,
				`${error.message}\n${join(APP_HOME_DIR, "settings.json")}`,
			);
		}
	}

	private reportConfigDiagnostics(diagnostics: ConfigDiagnostic[]): void {
		for (const diagnostic of diagnostics) {
			log.logWarning(`[${this.channelId}] ${formatConfigDiagnostic(diagnostic)}`, diagnostic.path);
		}
	}

	private buildRuntimeTools(): AgentTool<any>[] {
		const securityLoad = loadSecurityConfigWithDiagnostics(APP_HOME_DIR);
		const toolsLoad = loadToolsConfigWithDiagnostics(APP_HOME_DIR);
		this.reportConfigDiagnostics([...securityLoad.diagnostics, ...toolsLoad.diagnostics]);

		return createPipiclawTools({
			executor: this.executor,
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
			getSessionSearchSettings: () => this.settingsManager.getSessionSearchSettings(),
			memoryCandidateStore: this.memoryCandidateStore,
			securityConfig: securityLoad.config,
			toolsConfig: toolsLoad.config,
		});
	}

	private rebuildSessionTools(): void {
		const tools = this.buildRuntimeTools();
		this.agent.setTools(tools);
		(this.session as unknown as { _baseToolsOverride?: Record<string, AgentTool<any>> })._baseToolsOverride =
			Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	}

	// === Session event subscription ===

	private subscribeToSessionEvents(): void {
		this.session.subscribe(async (event: unknown) => {
			if (isRecord(event) && "reason" in event && event.reason === "new") {
				this.firstTurnMemoryBootstrapPending = true;
			}
			if (!this.runState.ctx || !this.runState.logCtx || !this.runState.queue) return;
			await handleSessionEvent(event, {
				ctx: this.runState.ctx,
				logCtx: this.runState.logCtx,
				queue: this.runState.queue,
				pendingTools: this.runState.pendingTools,
				store: this.runState.store,
				runState: this.runState,
				memoryLifecycle: this.memoryLifecycle,
				refreshSessionResources: async () => {
					await this.refreshSessionResources();
				},
			});
		});
	}

	private async buildFirstTurnMemoryBootstrap(): Promise<string> {
		const readOptionalFile = async (path: string): Promise<string> => {
			try {
				return await readFile(path, "utf-8");
			} catch {
				return "";
			}
		};

		const [channelMemory, workspaceMemory] = await Promise.all([
			readOptionalFile(getChannelMemoryPath(this.channelDir)),
			readOptionalFile(join(this.workspaceDir, "MEMORY.md")),
		]);

		return renderFirstTurnMemoryBootstrap({
			channelMemory,
			workspaceMemory,
		});
	}
}
