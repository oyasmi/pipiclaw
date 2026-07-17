import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	AgentSession,
	AgentSessionRuntime,
	type AgentSessionServices,
	AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	DefaultResourceLoader,
	type LoadExtensionsResult,
	type ModelRegistry,
	type ResourceLoader,
	type SettingsManager as SDKSettingsManager,
	SessionManager,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { createExecutor, type Executor } from "../executor.js";
import * as log from "../log.js";
import {
	buildFirstTurnMemoryBootstrapResult,
	FIRST_TURN_BOOTSTRAP_MAX_UNITS,
	type FirstTurnMemoryBootstrapResult,
} from "../memory/bootstrap.js";
import { createMemoryCandidateStore, type MemoryCandidateStore } from "../memory/candidates.js";
import { handleMemoryCommand } from "../memory/commands.js";
import { getChannelMemoryPath } from "../memory/files.js";
import { MemoryLifecycle } from "../memory/lifecycle.js";
import {
	applyMemoryActivityToState,
	type MemoryActivityEvent,
	updateMemoryMaintenanceState,
} from "../memory/maintenance-state.js";
import { MEMORY_RECALL_MAX_UNITS, recallRelevantMemory } from "../memory/recall.js";
import type { MemoryMaintenanceRuntimeContext } from "../memory/scheduler.js";
import { buildTaskDigest, TASK_AGENDA_MAX_UNITS } from "../memory/task-digest.js";
import { getApiKeyForModel } from "../models/api-keys.js";
import {
	createModelRegistry,
	findExactModelReferenceMatch,
	formatModelReference,
	resolveInitialModel,
} from "../models/utils.js";
import { loadRuntimePlaybookCatalog, selectRuntimePlaybooks } from "../playbooks/catalog.js";
import type { ChannelContext } from "../runtime/channel-context.js";
import type { ChannelStore } from "../runtime/store.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { PipiclawSettingsManager } from "../settings.js";
import { type ConfigDiagnostic, formatConfigDiagnostic } from "../shared/config-diagnostics.js";
import { countPromptUnits } from "../shared/prompt-units.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { UsageTotals } from "../shared/types.js";
import { discoverSubAgents, type SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { loadToolsConfigWithDiagnostics } from "../tools/config.js";
import { createPipiclawTools } from "../tools/index.js";
import { TOOL_PROMPT_HINTS } from "../tools/registry.js";
import { getUsageLedger } from "../usage/ledger.js";
import { createCommandExtension } from "./command-extension.js";
import { isKnownCommandName, type RunnerBuiltInCommand, renderBuiltInHelp, slashCommandName } from "./commands.js";
import { estimateIncomingMessageTokens, getPreventiveCompactionDecision } from "./context-budget.js";
import {
	type FallbackRunDeps,
	PRIMARY_COOLDOWN_MS,
	runPromptWithFallback,
	shouldRestorePrimary,
} from "./model-fallback.js";
import { clipUserInput, formatProgressEntry } from "./progress-formatter.js";
import { buildPipiclawSystemPrompt } from "./prompt/builder.js";
import { createPromptBoundaryExtension } from "./prompt/extension.js";
import { buildPromptManifest, type PromptTurnContextStats, renderContextReport } from "./prompt/manifest.js";
import { loadWorkspacePromptResources, type WorkspacePromptResources } from "./prompt/resources.js";
import type { PromptBuildResult } from "./prompt/types.js";
import { createRunQueue } from "./run-queue.js";
import type { RunnerFactoryPaths } from "./runner-factory.js";
import { handleSessionEvent } from "./session-events.js";
import { SessionResourceGate } from "./session-resource-gate.js";
import { getLastAssistantUsage } from "./type-guards.js";
import {
	type AgentRunner,
	createEmptyRunState,
	type FinalOutcome,
	MAX_USER_MESSAGE_CHARS,
	type RunnerStatusSnapshot,
	type RunState,
	type TurnPhase,
	type TurnStatus,
} from "./types.js";
import { loadPipiclawSkills, type PipiclawSkillsResult, resolvePipiclawSkills } from "./workspace-resources.js";

function isSilentOutcome(outcome: FinalOutcome): outcome is { kind: "silent" } {
	return outcome.kind === "silent";
}

function isFinalOutcome(outcome: FinalOutcome): outcome is { kind: "final"; text: string } {
	return outcome.kind === "final";
}

function getFinalOutcomeText(outcome: FinalOutcome): string | null {
	return isFinalOutcome(outcome) ? outcome.text : null;
}

function asSdkSettingsManager(manager: PipiclawSettingsManager): SDKSettingsManager {
	return manager as unknown as SDKSettingsManager;
}

export class ChannelRunner implements AgentRunner {
	// --- Constructed once ---
	private readonly executor: Executor;
	private readonly channelId: string;
	private readonly channelDir: string;
	private readonly appHomeDir: string;
	private readonly authConfigPath: string;
	private readonly modelsConfigPath: string;
	private readonly workspaceDir: string;
	private session: AgentSession;
	private agent: Agent;
	private sessionManager: SessionManager;
	private readonly settingsManager: PipiclawSettingsManager;
	private readonly modelRegistry: ModelRegistry;
	private readonly memoryLifecycle: MemoryLifecycle;
	private readonly ledger = getUsageLedger();
	private readonly memoryCandidateStore: MemoryCandidateStore;
	private readonly sessionResourceGate: SessionResourceGate;
	private readonly sessionReady: Promise<void>;
	private readonly sessionRuntime: AgentSessionRuntime;
	private sessionUnsubscribe?: () => void;
	private subAgentDiscovery: SubAgentDiscoveryResult;

	// --- Mutable across runs ---
	private activeModel: Model<Api>;
	private currentSkills: PipiclawSkillsResult;
	/** Last built system prompt (spec 025): feeds the boundary footer, /context and the debug manifest. */
	private lastPromptBuild?: PromptBuildResult;
	/** SOUL/AGENTS as resolved for the last build, for the `/context` independent-budget lines. */
	private lastWorkspaceResources?: WorkspacePromptResources;
	/** The exact system prompt the provider last received (our prompt + pi's tail + footer). */
	private lastFinalPrompt?: string;
	private lastTurnContextStats?: PromptTurnContextStats;
	private currentTools: AgentTool<any>[] = [];
	private firstTurnMemoryBootstrapPending = true;
	/** Mirror of `tools.tasks.enabled` from the last tools-config load (see buildRuntimeTools). */
	private tasksEnabled = true;
	/** Single owner of turn state; see TurnPhase in types.ts. */
	private turn: { phase: TurnPhase; stopRequested: boolean; taskText?: string } = {
		phase: "idle",
		stopRequested: false,
	};
	/** When the primary model last failed and we switched to the backup. null = on primary. */
	private primaryFailedAt: number | null = null;

	// --- Per run ---
	private runState: RunState = createEmptyRunState();

	constructor(channelId: string, channelDir: string, paths: RunnerFactoryPaths) {
		this.channelId = channelId;
		this.channelDir = channelDir;
		this.appHomeDir = paths.appHomeDir;
		this.authConfigPath = paths.authConfigPath;
		this.modelsConfigPath = paths.modelsConfigPath;

		const executor = createExecutor();
		this.executor = executor;
		this.workspaceDir = resolve(dirname(channelDir));

		// Initial skill summaries
		const initialSkills = loadPipiclawSkills(channelDir);
		this.currentSkills = initialSkills;

		// Create session manager
		const contextFile = join(channelDir, "context.jsonl");
		this.sessionManager = SessionManager.open(contextFile, channelDir);
		this.settingsManager = new PipiclawSettingsManager(this.appHomeDir);
		this.reportSettingsDiagnostics();
		this.memoryCandidateStore = createMemoryCandidateStore();

		// Create AuthStorage and ModelRegistry
		const authStorage = AuthStorage.create(this.authConfigPath);
		this.modelRegistry = createModelRegistry(authStorage, this.modelsConfigPath);

		// Resolve model: prefer saved global default, fall back to first available model
		this.activeModel = resolveInitialModel(this.modelRegistry, this.settingsManager);
		log.logInfo(`Using model: ${this.activeModel.provider}/${this.activeModel.id} (${this.activeModel.name})`);
		this.subAgentDiscovery = this.refreshSubAgentDiscovery();

		const initialSessionManager = this.sessionManager;
		const initialTools = this.buildRuntimeTools();
		this.agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: this.activeModel,
				thinkingLevel: "off",
				tools: initialTools,
			},
			convertToLlm,
			getApiKey: async () => getApiKeyForModel(this.modelRegistry, this.activeModel),
		});

		this.memoryLifecycle = new MemoryLifecycle({
			channelId: this.channelId,
			channelDir: this.channelDir,
			appHomeDir: this.appHomeDir,
			getMessages: () => this.session.messages,
			getSessionEntries: () => this.sessionManager.getBranch(),
			getModel: () => this.session.model ?? this.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			getSessionMemorySettings: () => this.settingsManager.getSessionMemorySettings(),
			recordMemoryActivity: (event) => {
				void this.recordMemoryActivity(event);
			},
		});

		const initialResourceLoader = this.createResourceLoader();
		const baseToolsOverride = Object.fromEntries(initialTools.map((tool) => [tool.name, tool]));
		this.session = new AgentSession({
			agent: this.agent,
			sessionManager: initialSessionManager,
			settingsManager: asSdkSettingsManager(this.settingsManager),
			cwd: process.cwd(),
			modelRegistry: this.modelRegistry,
			resourceLoader: initialResourceLoader,
			baseToolsOverride,
		});
		this.sessionRuntime = new AgentSessionRuntime(
			this.session,
			this.createAgentSessionServices(initialResourceLoader),
			async ({ sessionManager, sessionStartEvent }) => {
				const next = this.createSessionRuntime(sessionManager, sessionStartEvent);
				return {
					session: next.session,
					extensionsResult: this.createEmptyExtensionsResult(),
					services: this.createAgentSessionServices(next.resourceLoader),
					diagnostics: [],
				};
			},
		);
		this.sessionRuntime.setRebindSession(async (session) => {
			this.session = session;
			this.agent = session.agent;
			this.sessionManager = session.sessionManager;
			await this.bindSessionExtensions();
			this.subscribeToSessionEvents();
		});
		this.sessionResourceGate = new SessionResourceGate(async () => {
			await this.reloadSessionResources();
		});

		// Subscribe to session events
		this.subscribeToSessionEvents();
		this.sessionReady = this.initializeSession();
	}

	// === Public API ===

	beginTurn(taskText: string): void {
		if (this.turn.phase !== "idle") {
			log.logWarning(`[${this.channelId}] beginTurn while phase=${this.turn.phase}; turns must be serialized`);
		}
		this.turn = { phase: "dispatching", stopRequested: false, taskText };
	}

	endTurn(): void {
		this.turn = { phase: "idle", stopRequested: false };
	}

	isBusy(): boolean {
		return this.turn.phase !== "idle";
	}

	requestStop(): void {
		if (this.turn.phase !== "idle") {
			this.turn.stopRequested = true;
		}
	}

	getTurnStatus(): TurnStatus {
		return { ...this.turn };
	}

	async run(
		ctx: ChannelContext,
		store: ChannelStore,
	): Promise<{
		stopReason: string;
		errorMessage?: string;
		usage: UsageTotals;
		durationMs: number;
		silent: boolean;
	}> {
		const startedAt = Date.now();
		this.resetRunState(ctx, store);
		// Direct callers (tests) may skip the transport's beginTurn/endTurn wrapper;
		// then run() owns the whole turn itself.
		const implicitTurn = this.turn.phase === "idle";
		if (implicitTurn) {
			this.beginTurn(ctx.message.text);
		}
		this.turn.phase = "preparing";

		const runQueue = createRunQueue();
		this.runState.queue = runQueue.queue;
		let promptSubmitted = false;
		let fallbackAttempted = false;
		let fallbackTargetRef: string | undefined;
		// Hoisted so the debug dump in `finally` can report the turn as it was actually sent.
		let promptText = "";
		let recalledContextText = "";
		let taskDigestText = "";
		let durableMemoryBootstrapText = "";
		let channelCapsuleText = "";
		let bootstrapCandidateIds: string[] = [];
		let bootstrapPrepared = false;

		try {
			await this.ensureSessionReady();
			await this.maybeRestorePrimaryModel();
			this.memoryLifecycle.noteUserTurnStarted();
			const normalizedInputLength = ctx.message.text.replace(/\r/g, "").trim().length;
			if (normalizedInputLength > MAX_USER_MESSAGE_CHARS) {
				await ctx.respondInThread(
					`⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理。`,
				);
			}
			const clippedInput = clipUserInput(ctx.message.text, MAX_USER_MESSAGE_CHARS);
			const userMessage = this.formatUserMessage(clippedInput, ctx.message.userName);
			const preserveRawInput = this.shouldPreserveRawInput(ctx.message.text);

			// Ensure channel directory exists
			await mkdir(this.channelDir, { recursive: true });

			promptText = preserveRawInput ? clippedInput : userMessage;

			if (!preserveRawInput) {
				// Channel facts are turn-dynamic by design (spec 025 §7.3): keeping them out of the
				// system prompt is what lets every channel in a workspace share one cached prefix.
				channelCapsuleText = this.renderChannelTurnContext();
				promptText = `${channelCapsuleText}\n\n<user_message>\n${promptText}\n</user_message>`;

				if (this.firstTurnMemoryBootstrapPending) {
					const bootstrap = await this.buildFirstTurnMemoryBootstrap();
					durableMemoryBootstrapText = bootstrap.renderedText;
					bootstrapCandidateIds = bootstrap.includedCandidateIds;
					bootstrapPrepared = true;
				}

				const recallSettings = this.settingsManager.getMemoryRecallSettings();
				if (recallSettings.enabled) {
					const recall = await recallRelevantMemory({
						query: clippedInput,
						channelId: this.channelId,
						workspaceDir: this.workspaceDir,
						channelDir: this.channelDir,
						maxCandidates: recallSettings.maxCandidates,
						maxInjected: recallSettings.maxInjected,
						maxChars: recallSettings.maxChars,
						// The configured char cap and the runtime unit cap both apply; first to bind clips.
						maxUnits: MEMORY_RECALL_MAX_UNITS,
						rerankWithModel: recallSettings.rerankWithModel,
						excludedCandidateIds: bootstrapCandidateIds,
						// Let shouldUseModelRerank's own memory-intent gate decide (it already handles
						// Chinese phrasing) — forcing autoRerank for every Han-script message triggered a
						// model rerank (up to 8s) on nearly every Chinese turn once memory filled up.
						model: this.session.model ?? this.activeModel,
						resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
						candidateStore: this.memoryCandidateStore,
					});

					if (recall.renderedText) {
						recalledContextText = recall.renderedText;
						promptText = `${recall.renderedText}\n\n${promptText}`;
					}
				}

				// Gated by the same master autonomy switch as task_manage and the TaskDriver.
				if (this.tasksEnabled) {
					const taskDigestSettings = this.settingsManager.getTaskDigestSettings();
					taskDigestText = await buildTaskDigest({
						channelDir: this.channelDir,
						maxTasks: taskDigestSettings.maxTasks,
						maxChars: taskDigestSettings.maxChars,
						maxUnits: TASK_AGENDA_MAX_UNITS,
					});
					if (taskDigestText) {
						promptText = `${taskDigestText}\n\n${promptText}`;
					}
				}

				if (durableMemoryBootstrapText) {
					promptText = `${durableMemoryBootstrapText}\n\n${promptText}`;
				}
			}

			// Estimated against the fully assembled prompt (recall + task digest + bootstrap all
			// prepended above), not just the bare user message — those pieces can add thousands of
			// characters and must count against the projected context usage this guard is checking.
			await this.maybeRunPreventiveCompactionForIncomingText(promptText);

			this.lastTurnContextStats = {
				durableMemoryChars: durableMemoryBootstrapText.length,
				durableMemoryUnits: countPromptUnits(durableMemoryBootstrapText),
				taskDigestChars: taskDigestText.length,
				taskDigestUnits: countPromptUnits(taskDigestText),
				recalledMemoryChars: recalledContextText.length,
				recalledMemoryUnits: countPromptUnits(recalledContextText),
				channelCapsuleUnits: countPromptUnits(channelCapsuleText),
				userMessageChars: clippedInput.length,
			};

			const fallbackDeps: FallbackRunDeps = {
				prompt: async (text) => {
					try {
						await this.sessionResourceGate.runPrompt(async () => {
							await this.session.prompt(text);
							promptSubmitted = true;
							if (bootstrapPrepared) this.firstTurnMemoryBootstrapPending = false;
						});
					} catch (err) {
						this.runState.stopReason = "error";
						this.runState.errorMessage = errorMessage(err);
						log.logEvent("error", "agent.turn.failed", "Runner failed", {
							ctx: this.runState.logCtx ?? { channelId: this.channelId },
							fields: { error: this.runState.errorMessage },
						});
					}
				},
				getRunError: () => ({
					stopReason: this.runState.stopReason,
					errorMessage: this.runState.errorMessage,
				}),
				resetRunError: () => {
					this.runState.stopReason = "stop";
					this.runState.errorMessage = undefined;
					this.runState.finalOutcome = { kind: "none" };
					this.runState.lastCompactionError = undefined;
				},
				getMessages: () => this.agent.state.messages,
				setMessages: (messages) => {
					this.agent.state.messages = messages as typeof this.agent.state.messages;
				},
				promptWasSubmitted: () => promptSubmitted,
				getCurrentModelRef: () => formatModelReference(this.session.model ?? this.activeModel),
				resolveFallbackModel: () => this.resolveFallbackModel(),
				setModel: async (model) => {
					await this.session.setModel(model);
				},
				notifySwitch: (from, to, errorSummary) => {
					fallbackTargetRef = to;
					if (this.runState.logCtx) {
						log.logModelFallback(this.runState.logCtx, from, to, errorSummary);
					}
					const text = `⚠️ 模型 ${from} 出错（${errorSummary}），切换到 ${to} 重试…`;
					if (ctx.progressStyle !== "none") {
						runQueue.queue.enqueue(
							() => ctx.respond(formatProgressEntry("error", text), false),
							"fallback switch",
						);
					} else {
						runQueue.queue.enqueue(() => ctx.respondInThread(text), "fallback switch");
					}
				},
				markPrimaryFailed: () => {
					this.primaryFailedAt = Date.now();
				},
			};
			fallbackAttempted = await runPromptWithFallback(promptText, fallbackDeps);
		} catch (err) {
			this.runState.stopReason = "error";
			this.runState.errorMessage = errorMessage(err);
			log.logEvent("error", "agent.turn.failed", "Runner failed", {
				ctx: this.runState.logCtx ?? { channelId: this.channelId },
				fields: { error: this.runState.errorMessage },
			});
		} finally {
			this.turn.phase = "finishing";
			// Debug dump (PIPICLAW_DEBUG=1). Written after the run so `systemPrompt` is the
			// string the provider actually received — base sections, pi's tail, and the boundary
			// footer the prompt extension appends at before_agent_start.
			if (process.env.PIPICLAW_DEBUG) {
				const debugContext = {
					systemPrompt: this.lastFinalPrompt ?? this.agent.state.systemPrompt,
					promptManifest: this.lastPromptBuild
						? buildPromptManifest(this.lastPromptBuild, this.lastFinalPrompt)
						: undefined,
					messages: this.session.messages,
					durableMemoryBootstrap: durableMemoryBootstrapText || undefined,
					taskDigest: taskDigestText || undefined,
					recalledContext: recalledContextText || undefined,
					newUserMessage: promptText,
				};
				await writeFile(join(this.channelDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2)).catch(
					(error: unknown) =>
						log.logWarning(`[${this.channelId}] Failed to write last_prompt.json`, errorMessage(error)),
				);
			}
			if (!promptSubmitted) {
				const discarded = this.session.clearQueue();
				const discardedCount = discarded.steering.length + discarded.followUp.length;
				if (discardedCount > 0) {
					log.logWarning(
						`[${this.channelId}] Discarded ${discardedCount} queued busy message(s) after run setup failed`,
					);
				}
			}
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
						if (fallbackAttempted && fallbackTargetRef) {
							detailLines.push(`已切换备用模型 \`${fallbackTargetRef}\` 重试，仍失败。`);
						}
						await ctx.replaceMessage(`_Sorry, something went wrong._\n\n${detailLines.join("\n\n")}`);
					} catch (err) {
						const errMsg = errorMessage(err);
						log.logWarning("Failed to post error message", errMsg);
					}
				} else if (isSilentOutcome(finalOutcome)) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message");
					} catch (err) {
						const errMsg = errorMessage(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (this.runState.stopReason === "aborted" && !this.runState.finalResponseDelivered) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Aborted response - discarded active delivery state");
					} catch (err) {
						const errMsg = errorMessage(err);
						log.logWarning("Failed to discard active delivery state after abort", errMsg);
					}
				} else if (finalOutcomeText && !this.runState.finalResponseDelivered) {
					try {
						await ctx.replaceMessage(finalOutcomeText);
					} catch (err) {
						const errMsg = errorMessage(err);
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
				const responseModel = lastAssistantMessage?.responseModel;
				// Ledger turn entry: assistant-only usage (sub-agents recorded separately),
				// keeping Σ(entries) == real spend with no double counting.
				this.ledger.record({
					channelId: this.channelId,
					kind: "turn",
					model: responseModel ?? formatModelReference(currentRunModel),
					usage: {
						input: this.runState.assistantUsage.input,
						output: this.runState.assistantUsage.output,
						cacheRead: this.runState.assistantUsage.cacheRead,
						cacheWrite: this.runState.assistantUsage.cacheWrite,
						total: this.runState.assistantUsage.total,
					},
					cost: { ...this.runState.assistantUsage.cost },
				});
				if (
					responseModel &&
					responseModel !== formatModelReference(currentRunModel) &&
					responseModel !== currentRunModel.id
				) {
					log.logInfo(
						`[${this.channelId}] Actual model: ${responseModel} (configured: ${formatModelReference(currentRunModel)})`,
					);
				}
			}

			// Clear run state
			this.runState.ctx = null;
			this.runState.logCtx = null;
			this.runState.queue = null;
			if (implicitTurn) {
				this.endTurn();
			}
		}

		return {
			stopReason: this.runState.stopReason,
			errorMessage: this.runState.errorMessage,
			usage: { ...this.runState.totalUsage, cost: { ...this.runState.totalUsage.cost } },
			durationMs: Date.now() - startedAt,
			silent: this.runState.finalOutcome.kind === "silent",
		};
	}

	async handleBuiltinCommand(ctx: ChannelContext, command: RunnerBuiltInCommand): Promise<void> {
		try {
			switch (command.name) {
				case "help":
					await this.sendCommandReply(ctx, renderBuiltInHelp());
					return;
				case "context":
					await this.sendCommandReply(ctx, this.renderContextReport(command.args));
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
				default: {
					// The four session/query commands (events/tasks/status/usage) are
					// routed to their own handlers upstream and never reach here; the
					// narrowed parameter type makes that a compile-time guarantee.
					const _exhaustive: never = command.name;
					throw new Error(`Unhandled built-in command: ${String(_exhaustive)}`);
				}
			}
		} catch (err) {
			const errMsg = errorMessage(err);
			log.logWarning(`[${this.channelId}] Built-in command failed`, errMsg);
			await this.sendCommandReply(ctx, `命令执行失败：${errMsg}`);
		}
	}

	/**
	 * True if `text` is a slash command the runtime or session layer can handle:
	 * a built-in, a session command (`/model` …), a skill (`/skill:name`), or a
	 * file-based prompt template registered on the live session. Unknown slash
	 * commands are rejected at dispatch so a typo like `/modle` never becomes a
	 * full LLM turn.
	 */
	isKnownSlashCommand(text: string): boolean {
		const name = slashCommandName(text);
		if (!name) {
			return false;
		}
		if (isKnownCommandName(name)) {
			return true;
		}
		return this.session.promptTemplates.some((template) => template.name.toLowerCase() === name);
	}

	async queueSteer(text: string, userName?: string): Promise<void> {
		await this.queueBusyMessage(this.requireQueuedMessage(text, "steer"), userName);
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
			messages: [...this.session.messages],
			sessionEntries: [...this.sessionManager.getBranch()],
			model: this.session.model ?? this.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			settings: {
				sessionMemory: this.settingsManager.getSessionMemorySettings(),
				memoryGrowth: this.settingsManager.getMemoryGrowthSettings(),
				memoryMaintenance: this.settingsManager.getMemoryMaintenanceSettings(),
			},
			loadedSkills: this.currentSkills.skills.map((skill) => ({
				name: skill.name,
				description: skill.description,
			})),
			refreshWorkspaceResources: async () => {
				await this.refreshSessionResources();
			},
		};
	}

	getStatusSnapshot(): RunnerStatusSnapshot {
		const model = this.session.model ?? this.activeModel;
		const contextTokens = this.session.getContextUsage()?.tokens;
		const fallbackActive = formatModelReference(model) !== formatModelReference(this.activeModel);
		return {
			model: formatModelReference(model),
			contextTokens: typeof contextTokens === "number" ? contextTokens : undefined,
			contextWindow: model.contextWindow || 200000,
			thinkingLevel: this.session.thinkingLevel,
			fallback: fallbackActive
				? {
						primary: formatModelReference(this.activeModel),
						cooldownUntilMs: (this.primaryFailedAt ?? Date.now()) + PRIMARY_COOLDOWN_MS,
					}
				: undefined,
		};
	}

	async abort(): Promise<void> {
		await this.session.abort();
	}

	/**
	 * `/context` — read-only prompt accounting, no LLM cost. Reports the section
	 * breakdown of the system prompt, the tool schemas (billed on top of it, and
	 * often the larger half), and the last turn's dynamic context.
	 */
	renderContextReport(args = ""): string {
		const build = this.lastPromptBuild ?? this.buildSystemPrompt();
		return renderContextReport({
			build,
			finalPrompt: this.lastFinalPrompt,
			skills: this.currentSkills.skills.map((skill) => ({ name: skill.name, description: skill.description })),
			toolNames: this.currentTools.map((tool) => tool.name),
			toolSchemaChars: this.currentTools.reduce(
				(sum, tool) =>
					sum + tool.name.length + tool.description.length + JSON.stringify(tool.parameters ?? {}).length,
				0,
			),
			soul: this.lastWorkspaceResources?.soul,
			agents: this.lastWorkspaceResources?.agents,
			lastTurn: this.lastTurnContextStats,
			detail: args.trim().toLowerCase() === "detail",
		});
	}

	// === Private helpers ===

	/**
	 * The per-turn channel capsule. It replaces the channel paths that used to sit in
	 * the system prompt: memory/task/event tools are already bound to this channel, so
	 * the model only needs the directory when it wants to read a file directly.
	 */
	private renderChannelTurnContext(): string {
		return [
			"<runtime_turn_context>",
			`Channel directory: ${this.channelDir}`,
			"SESSION.md, MEMORY.md, HISTORY.md and tasks/ live there and are runtime-maintained. Prefer the context supplied with this turn and the channel-bound tools; read those files directly only when you need detail they did not provide.",
			"</runtime_turn_context>",
		].join("\n");
	}

	private async sendCommandReply(ctx: ChannelContext, text: string): Promise<void> {
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
			await updateMemoryMaintenanceState(this.appHomeDir, this.channelId, (state) =>
				applyMemoryActivityToState(state, {
					...event,
					eligibleAfter,
				}),
			);
		} catch (error) {
			const message = errorMessage(error);
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

	/**
	 * Single source of truth for the busy-message window: steer is accepted while
	 * the prompt is being assembled ("preparing") or while the agent loop is
	 * actually streaming. Re-asserted after every await because the turn can end
	 * while this call was suspended.
	 */
	private assertBusyWindowOpen(): void {
		if (this.turn.phase === "preparing") {
			return;
		}
		if (this.turn.phase === "streaming" && this.session.isStreaming) {
			return;
		}
		throw new Error("No task is currently running.");
	}

	private async queueBusyMessage(text: string, userName?: string): Promise<void> {
		this.assertBusyWindowOpen();

		await this.ensureSessionReady();

		const clippedText = clipUserInput(text, MAX_USER_MESSAGE_CHARS);
		if (clippedText !== text.trim()) {
			log.logWarning(`[${this.channelId}] Queued message exceeded ${MAX_USER_MESSAGE_CHARS} chars and was clipped`);
		}
		const queuedMessage = this.formatUserMessage(clippedText, userName);
		await this.maybeRunPreventiveCompactionForIncomingText(queuedMessage);

		this.assertBusyWindowOpen();

		const queueMessage = async () => {
			this.assertBusyWindowOpen();
			await this.session.steer(queuedMessage);
		};

		await this.sessionResourceGate.runPrompt(queueMessage);
	}

	private resetRunState(ctx: ChannelContext, store: ChannelStore): void {
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

	/**
	 * At turn start, if a fallback is active and the primary's cooldown has elapsed,
	 * switch back to the preferred model. Silent — no user notice on recovery.
	 */
	private async maybeRestorePrimaryModel(): Promise<void> {
		const current = this.session.model;
		if (!current || formatModelReference(current) === formatModelReference(this.activeModel)) {
			this.primaryFailedAt = null;
			return;
		}
		if (!shouldRestorePrimary(this.primaryFailedAt, Date.now())) {
			return;
		}
		try {
			await this.session.setModel(this.activeModel);
			this.primaryFailedAt = null;
			log.logInfo(`[${this.channelId}] Restored primary model ${formatModelReference(this.activeModel)}`);
		} catch (err) {
			log.logWarning(`[${this.channelId}] Failed to restore primary model`, errorMessage(err));
		}
	}

	/**
	 * Resolve the configured backup model reference against available models.
	 * Returns null when unset, unresolvable/ambiguous, or missing an API key —
	 * each case logs a warning and disables fallback for this turn.
	 */
	private async resolveFallbackModel(): Promise<Model<Api> | null> {
		const reference = this.settingsManager.getFallbackModelReference();
		if (!reference) {
			return null;
		}
		this.modelRegistry.refresh();
		const available = await this.modelRegistry.getAvailable();
		const { match, ambiguous } = findExactModelReferenceMatch(reference, available);
		if (!match) {
			log.logWarning(
				`[${this.channelId}] fallbackModel "${reference}" ${ambiguous ? "is ambiguous" : "not found"}; skipping fallback`,
			);
			return null;
		}
		try {
			await getApiKeyForModel(this.modelRegistry, match);
		} catch {
			log.logWarning(`[${this.channelId}] fallbackModel "${reference}" has no API key; skipping fallback`);
			return null;
		}
		return match;
	}

	private async initializeSession(): Promise<void> {
		await this.reloadSessionResources();
		await this.bindSessionExtensions();
	}

	private async reloadSessionResources(): Promise<void> {
		this.settingsManager.reload();
		this.reportSettingsDiagnostics();
		const skills = loadPipiclawSkills(this.channelDir);
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
					return await this.sessionRuntime.newSession(options);
				},
				fork: async (entryId, options) => {
					const result = await this.sessionRuntime.fork(entryId, options);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, options);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return await this.sessionRuntime.switchSession(sessionPath, options);
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
			const message = errorMessage(error);
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
				`${error.message}\n${join(this.appHomeDir, "settings.json")}`,
			);
		}
	}

	private reportConfigDiagnostics(diagnostics: ConfigDiagnostic[]): void {
		for (const diagnostic of diagnostics) {
			log.logWarning(`[${this.channelId}] ${formatConfigDiagnostic(diagnostic)}`, diagnostic.path);
		}
	}

	/**
	 * Build the Pipiclaw-owned system prompt (spec 025). This replaces pi's default
	 * base prompt entirely: identity, execution contract, hard invariants, the tool
	 * catalog and the workspace files are ours. pi still appends its tail (skills,
	 * date, cwd), and the boundary footer is appended after that by the prompt
	 * extension.
	 *
	 * Nothing channel-specific enters this text — that is what lets two channels in
	 * one workspace share a cached prompt prefix. Channel facts ride the turn.
	 */
	private buildSystemPrompt(): PromptBuildResult {
		const toolNames = this.currentTools.map((tool) => tool.name);
		const resources = loadWorkspacePromptResources(this.workspaceDir);
		this.lastWorkspaceResources = resources;
		const build = buildPipiclawSystemPrompt({
			mode: "normal",
			cwd: process.cwd(),
			workspaceDir: this.workspaceDir,
			tools: this.currentTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				hint: TOOL_PROMPT_HINTS[tool.name],
			})),
			soul: resources.soul,
			agents: resources.agents,
			playbooks: selectRuntimePlaybooks(loadRuntimePlaybookCatalog(), toolNames),
			subAgents: this.subAgentDiscovery.agents.map((agent) => ({
				name: agent.name,
				description: agent.description,
			})),
			skills: this.currentSkills.skills.map((skill) => ({ name: skill.name, description: skill.description })),
		});

		for (const diagnostic of [...resources.diagnostics, ...build.diagnostics]) {
			if (diagnostic.level === "info") continue;
			log.logWarning(`[${this.channelId}] Prompt ${diagnostic.level} (${diagnostic.sectionId})`, diagnostic.message);
		}
		// Only a real change is worth a line: a reload that produced the same bytes is noise.
		if (this.lastPromptBuild?.fingerprint !== build.fingerprint) {
			log.logInfo(
				`[${this.channelId}] System prompt rebuilt: ${build.totalChars} chars, ~${build.estimatedTokens} tokens, sha256:${build.fingerprint.slice(0, 12)} (was ${this.lastPromptBuild ? `sha256:${this.lastPromptBuild.fingerprint.slice(0, 12)}` : "none"})`,
			);
		}
		this.lastPromptBuild = build;
		return build;
	}

	private createResourceLoader(): ResourceLoader {
		return new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: this.appHomeDir,
			settingsManager: asSdkSettingsManager(this.settingsManager),
			extensionFactories: [
				this.memoryLifecycle.createExtensionFactory(),
				createPromptBoundaryExtension({
					getFooter: () => this.lastPromptBuild?.footer ?? "",
					onFinalPrompt: (systemPrompt) => {
						this.lastFinalPrompt = systemPrompt;
					},
				}),
				createCommandExtension({
					getCurrentModel: () => this.session.model ?? this.activeModel,
					getAvailableModels: async () => {
						this.modelRegistry.refresh();
						return await this.modelRegistry.getAvailable();
					},
					getSessionStats: () => this.session.getSessionStats(),
					getThinkingLevel: () => this.session.thinkingLevel,
					getLastResponseModel: () => getLastAssistantUsage(this.session.messages)?.responseModel,
					switchModel: async (model) => {
						await this.session.setModel(model);
						this.activeModel = model;
						// Manual /model switch redefines the preferred model and clears fallback state.
						this.primaryFailedAt = null;
					},
					refreshSessionResources: async () => {
						await this.refreshSessionResources();
					},
					runMemoryCommand: async (args) => handleMemoryCommand({ channelDir: this.channelDir, args }),
				}),
			],
			// Pipiclaw owns the base prompt: with a custom prompt present, pi emits no
			// default identity, no pi docs index and no `Available tools: (none)` block.
			systemPromptOverride: () => this.buildSystemPrompt().text,
			// Nothing may slip in behind the section pipeline — not pi's app-level
			// APPEND_SYSTEM.md, not a base append. SOUL/AGENTS are rendered as sections.
			appendSystemPromptOverride: () => [],
			agentsFilesOverride: () => ({ agentsFiles: [] }),
			// Skills stay in the ResourceLoader: they drive `/skill:name` and pi's
			// `<available_skills>` index together. Only the merge policy is ours.
			skillsOverride: (base) => {
				const merged = resolvePipiclawSkills(base, this.currentSkills);
				for (const diagnostic of merged.diagnostics) {
					log.logWarning(
						`[${this.channelId}] Skill ${diagnostic.type}`,
						`${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`,
					);
				}
				return merged;
			},
		});
	}

	private createAgentSessionServices(resourceLoader: ResourceLoader): AgentSessionServices {
		return {
			cwd: process.cwd(),
			agentDir: this.appHomeDir,
			authStorage: AuthStorage.create(this.authConfigPath),
			settingsManager: asSdkSettingsManager(this.settingsManager),
			modelRegistry: this.modelRegistry,
			resourceLoader,
			diagnostics: [],
		};
	}

	private createEmptyExtensionsResult(): LoadExtensionsResult {
		return {
			extensions: [],
			errors: [],
			runtime: createExtensionRuntime(),
		};
	}

	private createSessionRuntime(
		sessionManager: SessionManager,
		sessionStartEvent?: SessionStartEvent,
	): { agent: Agent; session: AgentSession; resourceLoader: ResourceLoader } {
		const tools = this.buildRuntimeTools();
		const agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: this.activeModel,
				thinkingLevel: "off",
				tools,
			},
			convertToLlm,
			getApiKey: async () => getApiKeyForModel(this.modelRegistry, this.activeModel),
		});
		const resourceLoader = this.createResourceLoader();
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: asSdkSettingsManager(this.settingsManager),
			cwd: process.cwd(),
			modelRegistry: this.modelRegistry,
			resourceLoader,
			baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
			sessionStartEvent,
		});
		return { agent, session, resourceLoader };
	}

	private buildRuntimeTools(): AgentTool<any>[] {
		const securityLoad = loadSecurityConfigWithDiagnostics(this.appHomeDir);
		const toolsLoad = loadToolsConfigWithDiagnostics(this.appHomeDir);
		this.reportConfigDiagnostics([...securityLoad.diagnostics, ...toolsLoad.diagnostics]);
		this.tasksEnabled = toolsLoad.config.tools.tasks.enabled;

		const tools = createPipiclawTools({
			executor: this.executor,
			getCurrentModel: () => this.activeModel,
			getAvailableModels: () => this.modelRegistry.getAvailable(),
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			workspaceDir: this.workspaceDir,
			channelDir: this.channelDir,
			channelId: this.channelId,
			getSubAgentDiscovery: () => this.subAgentDiscovery,
			getMemoryRecallSettings: () => this.settingsManager.getMemoryRecallSettings(),
			getSessionSearchSettings: () => this.settingsManager.getSessionSearchSettings(),
			memoryCandidateStore: this.memoryCandidateStore,
			securityConfig: securityLoad.config,
			toolsConfig: toolsLoad.config,
		});
		this.currentTools = tools;
		return tools;
	}

	private rebuildSessionTools(): void {
		const tools = this.buildRuntimeTools();
		this.setSessionBaseToolsOverride(tools);
		this.agent.state.tools = tools;
		this.session.setActiveToolsByName(tools.map((tool) => tool.name));
	}

	/**
	 * Overwrite the SDK session's `baseToolsOverride` map so a resource reload swaps in
	 * freshly-built tools. The SDK exposes no public setter for this, so we reach into the
	 * private `_baseToolsOverride` field. This is the single, isolated point of that coupling:
	 * if a future SDK renames or removes the field, the guard below warns loudly instead of
	 * silently leaving stale tools in place. Replace with a public setter once upstream adds one.
	 */
	private setSessionBaseToolsOverride(tools: AgentTool<any>[]): void {
		const target = this.session as unknown as { _baseToolsOverride?: Record<string, AgentTool<any>> };
		if (!("_baseToolsOverride" in target)) {
			log.logWarning(
				`[${this.channelId}] AgentSession no longer exposes _baseToolsOverride; tool reloads may use stale tools (SDK change?)`,
			);
		}
		target._baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	}

	// === Session event subscription ===

	private subscribeToSessionEvents(): void {
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = this.session.subscribe((event: unknown) => {
			if (isRecord(event) && event.type === "message_start" && this.turn.phase === "preparing") {
				this.turn.phase = "streaming";
			}
			if (isRecord(event) && "reason" in event && event.reason === "new") {
				this.firstTurnMemoryBootstrapPending = true;
			}
			if (!this.runState.ctx || !this.runState.logCtx || !this.runState.queue) return;
			// The SDK listener signature is `(event) => void`, so the promise below is fire-and-forget.
			// Without this catch, a rejection inside handleSessionEvent becomes an unhandled rejection
			// that terminates the daemon under Node's default policy.
			handleSessionEvent(event, {
				ctx: this.runState.ctx,
				logCtx: this.runState.logCtx,
				queue: this.runState.queue,
				pendingTools: this.runState.pendingTools,
				store: this.runState.store,
				runState: this.runState,
				memoryLifecycle: this.memoryLifecycle,
				ledger: this.ledger,
				refreshSessionResources: async () => {
					await this.refreshSessionResources();
				},
			}).catch((err) => {
				log.logWarning(`[${this.channelId}] session event handler failed`, errorMessage(err));
			});
		});
	}

	private async buildFirstTurnMemoryBootstrap(): Promise<FirstTurnMemoryBootstrapResult> {
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

		return buildFirstTurnMemoryBootstrapResult({
			channelMemory,
			workspaceMemory,
			maxUnits: FIRST_TURN_BOOTSTRAP_MAX_UNITS,
		});
	}
}
