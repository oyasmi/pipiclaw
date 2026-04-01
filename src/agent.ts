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
import { COMMAND_RESULT_CUSTOM_TYPE, createCommandExtension } from "./command-extension.js";
import { type BuiltInCommand, renderBuiltInHelp } from "./commands.js";
import { getAgentConfig, getApiKeyForModel, getSoul, loadPipiclawSkills } from "./config-loader.js";
import { PipiclawSettingsManager } from "./context.js";
import type { DingTalkContext } from "./dingtalk.js";
import * as log from "./log.js";
import { createMemoryCandidateCache } from "./memory-candidates.js";
import { MemoryLifecycle } from "./memory-lifecycle.js";
import { recallRelevantMemory } from "./memory-recall.js";
import { resolveInitialModel } from "./model-utils.js";
import { APP_HOME_DIR, AUTH_CONFIG_PATH, MODELS_CONFIG_PATH } from "./paths.js";
import { buildAppendSystemPrompt } from "./prompt-builder.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import { extractLabelFromArgs, HAN_REGEX, truncate } from "./shared/text-utils.js";
import { isRecord } from "./shared/type-guards.js";
import type { UsageTotals } from "./shared/types.js";
import type { ChannelStore } from "./store.js";
import { discoverSubAgents, formatSubAgentList, type SubAgentDiscoveryResult } from "./sub-agents.js";
import { createPipiclawTools } from "./tools/index.js";
import type { SubAgentToolDetails } from "./tools/subagent.js";

// ============================================================================
// Types
// ============================================================================

export interface AgentRunner {
	run(ctx: DingTalkContext, store: ChannelStore): Promise<{ stopReason: string; errorMessage?: string }>;
	handleBuiltinCommand(ctx: DingTalkContext, command: BuiltInCommand): Promise<void>;
	queueSteer(text: string, userName?: string): Promise<void>;
	queueFollowUp(text: string, userName?: string): Promise<void>;
	abort(): Promise<void>;
}

type FinalOutcome = { kind: "none" } | { kind: "silent" } | { kind: "final"; text: string };
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

const MAX_USER_MESSAGE_CHARS = 12_000;

function sanitizeProgressText(text: string): string {
	return text
		.replace(/\uFFFC/g, "")
		.replace(/\r/g, "")
		.trim();
}

function clipUserInput(text: string, maxChars: number): string {
	const normalized = text.replace(/\r/g, "").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}

	const headChars = Math.floor(maxChars * 0.6);
	const tailChars = maxChars - headChars;
	return `${normalized.slice(0, headChars)}\n\n[... omitted ${normalized.length - maxChars} chars ...]\n\n${normalized.slice(-tailChars)}`;
}

function formatProgressEntry(kind: "tool" | "thinking" | "error" | "assistant", text: string): string {
	const cleaned = sanitizeProgressText(text);
	if (!cleaned) return "";

	const normalized = cleaned.replace(/\n+/g, " ").trim();
	switch (kind) {
		case "tool":
			return `Running: ${normalized}`;
		case "thinking":
			return `Thinking: ${normalized}`;
		case "error":
			return `Error: ${normalized}`;
		case "assistant":
			return normalized;
	}
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function isSubAgentToolDetails(value: unknown): value is SubAgentToolDetails {
	if (!value || typeof value !== "object" || !("kind" in value) || (value as { kind?: unknown }).kind !== "subagent") {
		return false;
	}

	if (!("usage" in value)) {
		return false;
	}

	const usage = (value as { usage?: unknown }).usage;
	return (
		!!usage &&
		typeof usage === "object" &&
		"input" in usage &&
		"output" in usage &&
		"cacheRead" in usage &&
		"cacheWrite" in usage &&
		"cost" in usage
	);
}

function mergeSubAgentUsage(totalUsage: UsageTotals, details: SubAgentToolDetails): void {
	totalUsage.input += details.usage.input;
	totalUsage.output += details.usage.output;
	totalUsage.cacheRead += details.usage.cacheRead;
	totalUsage.cacheWrite += details.usage.cacheWrite;
	totalUsage.total += details.usage.total;
	totalUsage.cost.input += details.usage.cost.input;
	totalUsage.cost.output += details.usage.cost.output;
	totalUsage.cost.cacheRead += details.usage.cost.cacheRead;
	totalUsage.cost.cacheWrite += details.usage.cost.cacheWrite;
	totalUsage.cost.total += details.usage.cost.total;
}

function extractCustomCommandResultText(message: unknown): string | null {
	if (
		!message ||
		typeof message !== "object" ||
		!("role" in message) ||
		!("customType" in message) ||
		(message as { role?: unknown }).role !== "custom" ||
		(message as { customType?: unknown }).customType !== COMMAND_RESULT_CUSTOM_TYPE
	) {
		return null;
	}

	const content = (message as { content?: unknown }).content;
	return typeof content === "string" && content.trim() ? content : null;
}

// ============================================================================
// Run State
// ============================================================================

interface PendingTool {
	toolName: string;
	args: unknown;
	startTime: number;
}

interface RunQueue {
	enqueue(fn: () => Promise<void>, errorContext: string): void;
	enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
}

interface RunState {
	ctx: DingTalkContext | null;
	logCtx: { channelId: string; userName?: string; channelName?: string } | null;
	store: ChannelStore | null;
	queue: RunQueue | null;
	pendingTools: Map<string, PendingTool>;
	totalUsage: UsageTotals;
	stopReason: string;
	errorMessage: string | undefined;
	finalOutcome: FinalOutcome;
	finalResponseDelivered: boolean;
}

function createEmptyRunState(): RunState {
	return {
		ctx: null,
		logCtx: null,
		store: null,
		queue: null,
		pendingTools: new Map(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined,
		finalOutcome: { kind: "none" },
		finalResponseDelivered: false,
	};
}

interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total?: number;
	totalTokens?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

type AssistantContentPart =
	| { type: "thinking"; thinking: string }
	| { type: "text"; text: string }
	| { type: "toolCall" }
	| { type: string; [key: string]: unknown };

interface AssistantEventMessage {
	role: "assistant";
	content: AssistantContentPart[];
	stopReason?: string;
	errorMessage?: string;
	usage?: AssistantUsage;
}

type SessionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "message_start"; message: unknown }
	| { type: "message_end"; message: unknown }
	| { type: "turn_end"; message: unknown; toolResults: unknown[] }
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
	| { type: "auto_compaction_end"; result?: { tokensBefore: number }; aborted?: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs?: number; errorMessage: string };

type ToolExecutionStartEvent = Extract<SessionEvent, { type: "tool_execution_start" }>;
type ToolExecutionUpdateEvent = Extract<SessionEvent, { type: "tool_execution_update" }>;
type ToolExecutionEndEvent = Extract<SessionEvent, { type: "tool_execution_end" }>;
type MessageStartEvent = Extract<SessionEvent, { type: "message_start" }>;
type MessageEndEvent = Extract<SessionEvent, { type: "message_end" }>;
type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;
type AutoCompactionStartEvent = Extract<SessionEvent, { type: "auto_compaction_start" }>;
type AutoCompactionEndEvent = Extract<SessionEvent, { type: "auto_compaction_end" }>;
type AutoRetryStartEvent = Extract<SessionEvent, { type: "auto_retry_start" }>;

function isMessageWithRole(value: unknown): value is { role: string } {
	return isRecord(value) && typeof value.role === "string";
}

function isAssistantEventMessage(value: unknown): value is AssistantEventMessage {
	return (
		isMessageWithRole(value) && value.role === "assistant" && Array.isArray((value as { content?: unknown }).content)
	);
}

function isAssistantUsageMessage(value: unknown): value is { role: "assistant"; stopReason?: string; usage: AssistantUsage } {
	if (!isMessageWithRole(value) || value.role !== "assistant" || !("usage" in value) || !isRecord(value.usage)) {
		return false;
	}
	return (
		typeof value.usage.input === "number" &&
		typeof value.usage.output === "number" &&
		typeof value.usage.cacheRead === "number" &&
		typeof value.usage.cacheWrite === "number" &&
		isRecord(value.usage.cost) &&
		typeof value.usage.cost.input === "number" &&
		typeof value.usage.cost.output === "number" &&
		typeof value.usage.cost.cacheRead === "number" &&
		typeof value.usage.cost.cacheWrite === "number" &&
		typeof value.usage.cost.total === "number"
	);
}

function getLastAssistantUsage(messages: readonly unknown[]): { stopReason?: string; usage: AssistantUsage } | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isAssistantUsageMessage(message) && message.stopReason !== "aborted") {
			return message;
		}
	}

	return null;
}

function asSdkSettingsManager(manager: PipiclawSettingsManager): SDKSettingsManager {
	return manager as unknown as SDKSettingsManager;
}

function isThinkingPart(part: AssistantContentPart): part is Extract<AssistantContentPart, { type: "thinking" }> {
	return part.type === "thinking" && typeof (part as { thinking?: unknown }).thinking === "string";
}

function isTextPart(part: AssistantContentPart): part is Extract<AssistantContentPart, { type: "text" }> {
	return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
}

function hasEventType(
	value: unknown,
	type: SessionEvent["type"],
): value is { type: SessionEvent["type"] } & Record<string, unknown> {
	return isRecord(value) && value.type === type;
}

function isToolExecutionStartEvent(value: unknown): value is ToolExecutionStartEvent {
	return (
		hasEventType(value, "tool_execution_start") &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string"
	);
}

function isToolExecutionUpdateEvent(value: unknown): value is ToolExecutionUpdateEvent {
	return (
		hasEventType(value, "tool_execution_update") &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string"
	);
}

function isToolExecutionEndEvent(value: unknown): value is ToolExecutionEndEvent {
	return (
		hasEventType(value, "tool_execution_end") &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		typeof value.isError === "boolean"
	);
}

function isMessageStartEvent(value: unknown): value is MessageStartEvent {
	return hasEventType(value, "message_start") && "message" in value;
}

function isMessageEndEvent(value: unknown): value is MessageEndEvent {
	return hasEventType(value, "message_end") && "message" in value;
}

function isTurnEndEvent(value: unknown): value is TurnEndEvent {
	return hasEventType(value, "turn_end") && "message" in value && Array.isArray(value.toolResults);
}

function isAutoCompactionStartEvent(value: unknown): value is AutoCompactionStartEvent {
	return hasEventType(value, "auto_compaction_start") && (value.reason === "threshold" || value.reason === "overflow");
}

function isAutoCompactionEndEvent(value: unknown): value is AutoCompactionEndEvent {
	return hasEventType(value, "auto_compaction_end");
}

function isAutoRetryStartEvent(value: unknown): value is AutoRetryStartEvent {
	return (
		hasEventType(value, "auto_retry_start") &&
		typeof value.attempt === "number" &&
		typeof value.maxAttempts === "number" &&
		typeof value.errorMessage === "string"
	);
}

// ============================================================================
// ChannelRunner
// ============================================================================

class ChannelRunner implements AgentRunner {
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

		// Create queue for this run
		let queueChain = Promise.resolve();
		this.runState.queue = {
			enqueue: (fn: () => Promise<void>, errorContext: string): void => {
				queueChain = queueChain.then(async () => {
					try {
						await fn();
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning(`DingTalk API error (${errorContext})`, errMsg);
					}
				});
			},
			enqueueMessage: function (text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
				this.enqueue(
					() => (target === "main" ? ctx.respond(text, doLog) : ctx.respondInThread(text)),
					errorContext,
				);
			},
		};

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
			await queueChain;
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

			const { ctx, logCtx, queue, pendingTools, store } = this.runState;

			if (isToolExecutionStartEvent(event)) {
				const label = extractLabelFromArgs(event.args) || event.toolName;

				pendingTools.set(event.toolCallId, {
					toolName: event.toolName,
					args: event.args,
					startTime: Date.now(),
				});
				this.memoryLifecycle.noteToolCall();

				log.logToolStart(logCtx, event.toolName, label, isRecord(event.args) ? event.args : {});
				queue.enqueue(() => ctx.respond(formatProgressEntry("tool", label), false), "tool label");
			} else if (isToolExecutionUpdateEvent(event)) {
				if (event.toolName !== "subagent") {
					return;
				}
				const partialText = truncate(extractToolResultText(event.partialResult), 200);
				if (!partialText.trim()) {
					return;
				}
				queue.enqueue(() => ctx.respond(formatProgressEntry("tool", partialText), false), "tool update");
			} else if (isToolExecutionEndEvent(event)) {
				const resultStr = extractToolResultText(event.result);
				const pending = pendingTools.get(event.toolCallId);
				pendingTools.delete(event.toolCallId);

				const durationMs = pending ? Date.now() - pending.startTime : 0;
				const subAgentDetails =
					event.toolName === "subagent" &&
					isRecord(event.result) &&
					"details" in event.result &&
					isSubAgentToolDetails((event.result as { details?: unknown }).details)
						? (event.result as { details: SubAgentToolDetails }).details
						: null;

				if (subAgentDetails) {
					mergeSubAgentUsage(this.runState.totalUsage, subAgentDetails);
					const label =
						pending?.args &&
						typeof pending.args === "object" &&
						"label" in pending.args &&
						typeof (pending.args as { label?: unknown }).label === "string"
							? ((pending.args as { label: string }).label ?? "subagent").trim()
							: "subagent";
					queue.enqueue(
						() =>
							store?.logSubAgentRun(logCtx.channelId, {
								date: new Date().toISOString(),
								toolCallId: event.toolCallId,
								label,
								agent: subAgentDetails.agent,
								source: subAgentDetails.source,
								model: subAgentDetails.model,
								tools: [...subAgentDetails.tools],
								turns: subAgentDetails.turns,
								toolCalls: subAgentDetails.toolCalls,
								durationMs: subAgentDetails.durationMs,
								failed: subAgentDetails.failed,
								failureReason: subAgentDetails.failureReason,
								output: resultStr.length > 16000 ? resultStr.slice(0, 16000) : resultStr,
								outputTruncated: resultStr.length > 16000,
								usage: {
									...subAgentDetails.usage,
									cost: { ...subAgentDetails.usage.cost },
								},
							}) ?? Promise.resolve(),
						"sub-agent run log",
					);
				}

				const treatAsError = event.isError || Boolean(subAgentDetails?.failed);
				if (treatAsError) {
					log.logToolError(logCtx, event.toolName, durationMs, resultStr);
				} else {
					log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
				}

				if (treatAsError) {
					queue.enqueue(
						() => ctx.respond(formatProgressEntry("error", truncate(resultStr, 200)), false),
						"tool error",
					);
				}
			} else if (isMessageStartEvent(event)) {
				if (isAssistantEventMessage(event.message)) {
					log.logResponseStart(logCtx);
				}
			} else if (isMessageEndEvent(event)) {
				const commandResultText = extractCustomCommandResultText(event.message);
				if (commandResultText) {
					this.runState.finalOutcome = { kind: "final", text: commandResultText };
					log.logResponse(logCtx, commandResultText);
					queue.enqueue(async () => {
						const delivered = await ctx.respondPlain(commandResultText);
						if (!delivered) {
							await ctx.replaceMessage(commandResultText);
						}
						this.runState.finalResponseDelivered = true;
					}, "command result");
					return;
				}

				if (isAssistantEventMessage(event.message)) {
					const assistantMsg = event.message;

					if (assistantMsg.stopReason) {
						this.runState.stopReason = assistantMsg.stopReason;
					}
					if (assistantMsg.errorMessage) {
						this.runState.errorMessage = assistantMsg.errorMessage;
					}

					if (assistantMsg.usage) {
						this.runState.totalUsage.input += assistantMsg.usage.input;
						this.runState.totalUsage.output += assistantMsg.usage.output;
						this.runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
						this.runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
						this.runState.totalUsage.total +=
							assistantMsg.usage.total ??
							assistantMsg.usage.totalTokens ??
							assistantMsg.usage.input +
								assistantMsg.usage.output +
								assistantMsg.usage.cacheRead +
								assistantMsg.usage.cacheWrite;
						this.runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
						this.runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
						this.runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
						this.runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
						this.runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
					}

					const content = assistantMsg.content;
					const thinkingParts: string[] = [];
					const textParts: string[] = [];
					let hasToolCalls = false;
					for (const part of content) {
						if (isThinkingPart(part)) {
							thinkingParts.push(part.thinking);
						} else if (isTextPart(part)) {
							textParts.push(part.text);
						} else if (part.type === "toolCall") {
							hasToolCalls = true;
						}
					}

					const text = textParts.join("\n");

					for (const thinking of thinkingParts) {
						log.logThinking(logCtx, thinking);
						queue.enqueue(() => ctx.respond(formatProgressEntry("thinking", thinking), false), "thinking");
					}

					if (hasToolCalls && text.trim()) {
						queue.enqueue(() => ctx.respond(formatProgressEntry("assistant", text), false), "assistant progress");
					}
				}
			} else if (isTurnEndEvent(event)) {
				if (isAssistantEventMessage(event.message) && event.toolResults.length === 0) {
					if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
						return;
					}

					const finalText = event.message.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text" && !!part.text)
						.map((part) => part.text)
						.join("\n");

					const trimmedFinalText = finalText.trim();
					if (!trimmedFinalText) {
						return;
					}

					if (trimmedFinalText === "[SILENT]" || trimmedFinalText.startsWith("[SILENT]")) {
						this.runState.finalOutcome = { kind: "silent" };
						this.memoryLifecycle.noteCompletedAssistantTurn();
						return;
					}

					if (
						this.runState.finalOutcome.kind === "final" &&
						this.runState.finalOutcome.text.trim() === trimmedFinalText
					) {
						return;
					}

					this.runState.finalOutcome = { kind: "final", text: finalText };
					this.memoryLifecycle.noteCompletedAssistantTurn();
					log.logResponse(logCtx, finalText);
					queue.enqueue(async () => {
						const delivered = await ctx.respondPlain(finalText);
						if (delivered) {
							this.runState.finalResponseDelivered = true;
						}
					}, "final response");
				}
			} else if (isAutoCompactionStartEvent(event)) {
				log.logInfo(`Auto-compaction started (reason: ${event.reason})`);
				queue.enqueue(
					() => ctx.respond(formatProgressEntry("assistant", "Compacting context..."), false),
					"compaction start",
				);
			} else if (isAutoCompactionEndEvent(event)) {
				if (event.result) {
					log.logInfo(`Auto-compaction complete: ${event.result.tokensBefore} tokens compacted`);
				} else if (event.aborted) {
					log.logInfo("Auto-compaction aborted");
				}
			} else if (isAutoRetryStartEvent(event)) {
				log.logWarning(`Retrying (${event.attempt}/${event.maxAttempts})`, event.errorMessage);
				queue.enqueue(
					() =>
						ctx.respond(
							formatProgressEntry("assistant", `Retrying (${event.attempt}/${event.maxAttempts})...`),
							false,
						),
					"retry",
				);
			}
		});
	}
}

// ============================================================================
// Factory
// ============================================================================

const channelRunners = new Map<string, AgentRunner>();

export function getOrCreateRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = new ChannelRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}
