import { Agent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, streamSimple } from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	AgentSessionRuntime,
	type AgentSessionServices,
	convertToLlm,
	createExtensionRuntime,
	DefaultResourceLoader,
	type LoadExtensionsResult,
	type ModelRegistry,
	type ModelRuntime,
	type ResourceLoader,
	SettingsManager as SDKSettingsManager,
	SessionManager,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { commitActiveSessionRef, resolveActiveSessionFile } from "../channel/active-session-store.js";
import type { ChannelContext, MediaSender } from "../channel/channel-context.js";
import { type InboundImage, MAX_INBOUND_IMAGE_BYTES } from "../channel/channel-event.js";
import { resolveProjectScope } from "../channel/project-scope-store.js";
import type { ChannelStore } from "../channel/store.js";
import {
	isKnownCommandName,
	type RunnerBuiltInCommand,
	renderBuiltInHelp,
	slashCommandName,
} from "../commands/catalog.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import * as log from "../log.js";
import { handleMemoryCommand } from "../memory/commands.js";
import {
	buildChannelIndexForBootstrap,
	clipJournalTailForBootstrap,
	clipWorkspaceMemoryForBootstrap,
} from "../memory/index-budget.js";
import { readJournalDay } from "../memory/journal.js";
import { MemoryLifecycle } from "../memory/lifecycle.js";
import {
	createMemoryActivityRecorder,
	type MemoryActivityEvent,
	type MemoryActivityRecorder,
} from "../memory/maintenance-state.js";
import { isChannelMigratedToV2, migrateChannelMemoryToV2 } from "../memory/migrate.js";
import { renderMemoryBootstrap } from "../memory/render.js";
import type { MemoryMaintenanceRuntimeContext } from "../memory/scheduler.js";
import { listMemoryEntries } from "../memory/store.js";
import { buildTaskDigest, TASK_AGENDA_MAX_UNITS } from "../memory/task-digest.js";
import { getApiKeyForModel } from "../models/api-keys.js";
import {
	createModelRuntime,
	defaultModel,
	findExactModelReferenceMatch,
	formatModelReference,
	hasKnownModelPricing,
	resolveInitialModel,
	wrapModelRegistry,
} from "../models/utils.js";
import { loadRuntimePlaybookCatalog, selectRuntimePlaybooks } from "../playbooks/catalog.js";
import type { LoadedSecurityConfig } from "../security/config.js";
import type { ProjectScope } from "../security/project-scope.js";
import { resolveProjectAccessPolicy } from "../security/project-scope.js";
import { type PipiclawSettingsManager, TASK_DIGEST_SETTINGS } from "../settings.js";
import { type ConfigDiagnostic, formatConfigDiagnostic } from "../shared/config-diagnostic.js";
import { formatLocalTime, localDayKey, localStampForFilename, parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { UsageTotals } from "../shared/types.js";
import { withTimeout } from "../shared/with-timeout.js";
import { discoverSubAgents, type SubAgentDiscoveryResult } from "../subagents/discovery.js";
import { loadToolsConfigWithDiagnostics } from "../tools/config.js";
import { createPipiclawTools } from "../tools/index.js";
import { formatSize } from "../tools/truncate.js";
import { getUsageLedger } from "../usage/ledger.js";
import { createCommandExtension } from "./command-extension.js";
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
import {
	buildPromptManifest,
	measureToolSchemas,
	type PromptTurnContextStats,
	renderContextReport,
	TOOL_SCHEMA_TARGET_UNITS,
	toolSchemaBudgetWarning,
} from "./prompt/manifest.js";
import { loadWorkspacePromptResources, type WorkspacePromptResources } from "./prompt/resources.js";
import type { PromptBuildResult } from "./prompt/types.js";
import { createRunQueue } from "./run-queue.js";
import type { RunnerDeps, RunnerFactoryPaths } from "./runner-factory.js";
import { handleSessionEvent } from "./session-events.js";
import { SessionResourceGate } from "./session-resource-gate.js";
import { assembleTurnPrompt } from "./turn-prompt.js";
import { recoverInterruptedTurn } from "./turn-recovery.js";
import { type TurnHandle, TurnStateMachine } from "./turn-state.js";
import { getLastAssistantUsage, isAutoCompactionEndEvent } from "./type-guards.js";
import {
	type AgentRunner,
	createEmptyRunState,
	type FinalOutcome,
	MAX_USER_MESSAGE_CHARS,
	type RunnerStatusSnapshot,
	type RunState,
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
	// The upstream session needs its broad interactive SettingsManager surface, while
	// Pipiclaw deliberately owns a small runtime-specific settings contract. Build a
	// real upstream manager from that contract instead of making PipiclawSettingsManager
	// pretend to implement dozens of unrelated no-op UI preferences.
	return SDKSettingsManager.inMemory({
		defaultProvider: manager.getDefaultProvider(),
		defaultModel: manager.getDefaultModel(),
		defaultThinkingLevel: manager.getDefaultThinkingLevel() ?? DEFAULT_MAIN_THINKING_LEVEL,
		compaction: manager.getCompactionSettings(),
		retry: manager.getRetrySettings(),
	});
}

const DEFAULT_MAIN_THINKING_LEVEL: ThinkingLevel = "medium";

/** Apply the pi 0.83 source-model thinking compatibility branch to one real AgentSession. */
export async function setModelWithThinkingPreservation(
	session: AgentSession,
	manager: SDKSettingsManager,
	model: Model<Api>,
): Promise<void> {
	const source = session.model;
	if (!source?.reasoning) {
		await session.setModel(model);
		return;
	}
	const previousDefault = manager.getDefaultThinkingLevel();
	manager.setDefaultThinkingLevel(session.thinkingLevel);
	try {
		await session.setModel(model);
	} finally {
		manager.setDefaultThinkingLevel(previousDefault ?? DEFAULT_MAIN_THINKING_LEVEL);
	}
}

export function setThinkingLevelWithConditionalPersist(session: AgentSession, level: ThinkingLevel): void {
	const before = session.thinkingLevel;
	session.setThinkingLevel(level);
	const effective = session.thinkingLevel;
	if (effective === before) return;
	if (!session.model?.reasoning && effective === "off") return;
	session.setThinkingLevel(effective, { persist: true });
}

export function cycleThinkingLevelWithConditionalPersist(session: AgentSession): ThinkingLevel | undefined {
	const before = session.thinkingLevel;
	const next = session.cycleThinkingLevel();
	const effective = session.thinkingLevel;
	if (next && effective !== before && (session.model?.reasoning || effective !== "off")) {
		session.setThinkingLevel(effective, { persist: true });
	}
	return next;
}

export function initializeThinkingLevelCompat(
	agent: Agent,
	model: Model<Api>,
	sessionManager: SessionManager,
	configuredDefault: ThinkingLevel | undefined,
): ThinkingLevel {
	const branch = sessionManager.getBranch();
	const hasThinkingEntry = branch.some((entry) => entry.type === "thinking_level_change");
	const historical = sessionManager.buildSessionContext().thinkingLevel as ThinkingLevel;
	const requested = hasThinkingEntry ? historical : (configuredDefault ?? DEFAULT_MAIN_THINKING_LEVEL);
	const effective = clampThinkingLevel(model, requested);
	agent.state.thinkingLevel = effective;
	if (!hasThinkingEntry) sessionManager.appendThinkingLevelChange(effective);
	return effective;
}

/**
 * Ceilings for the two awaited steps of a session-resource reload. Both reach
 * the network (model/auth re-resolution; the SDK session's own reload) and
 * neither carries a timeout of its own, so a stalled provider used to freeze a
 * reload — and, before the gate detached it, the turn that triggered it. On
 * timeout the reload keeps the resources it already had and logs.
 */
const MODEL_REGISTRY_REFRESH_TIMEOUT_MS = 15_000;
const SESSION_RELOAD_TIMEOUT_MS = 30_000;

export class ChannelRunner implements AgentRunner {
	// --- Constructed once ---
	private readonly executor: Executor;
	private readonly fileStore: FileStore;
	private readonly channelId: string;
	private readonly channelDir: string;
	private readonly appHomeDir: string;
	private readonly authConfigPath: string;
	private readonly modelsConfigPath: string;
	private readonly onSessionEvent?: (event: unknown, channelId: string) => void;
	private readonly mediaSender?: MediaSender;
	private readonly workspaceDir: string;
	/**
	 * Frozen for the lifetime of this runner generation (spec 043, D4.2): AgentSession, the
	 * ResourceLoader, and every tool closure built in this constructor and in `createSessionRuntime`
	 * (session-topology rebuilds only rebind the session, never the scope) all read this same value.
	 * Changing project is a dispose-and-rebuild of the whole runner, not a field mutation.
	 */
	private readonly projectScope: ProjectScope;
	/** Re-read per use, not captured once: an edited security.json takes effect without a restart. */
	private readonly loadSecurityConfig: () => LoadedSecurityConfig;
	private session!: AgentSession;
	/** Settings manager owned by the currently bound AgentSession. */
	private sessionSettingsManager!: SDKSettingsManager;
	private agent: Agent;
	private sessionManager: SessionManager;
	private readonly settingsManager: PipiclawSettingsManager;
	// modelRuntime is the canonical async model/auth facade (pi 0.80.8+); modelRegistry
	// is the synchronous read shell wrapped over it. Both are assigned in initializeSession
	// because ModelRuntime.create is async, so a placeholder model is used until then.
	private modelRuntime!: ModelRuntime;
	private modelRegistry!: ModelRegistry;
	private readonly memoryLifecycle: MemoryLifecycle;
	private readonly ledger = getUsageLedger();
	private readonly memoryActivityRecorder: MemoryActivityRecorder;
	private readonly sessionResourceGate: SessionResourceGate;
	private readonly sessionReady: Promise<void>;
	/**
	 * Flips true only once `initializeSession` has fully assigned `this.session`
	 * and loaded its resources. Synchronous dispatch-path callers (`isKnownSlashCommand`)
	 * must not touch `this.session` before this — the model runtime takes hundreds
	 * of ms to build and the first message can arrive first (spec 048 F2).
	 */
	private sessionInitialized = false;
	private sessionRuntime!: AgentSessionRuntime;
	private sessionUnsubscribe?: () => void;
	private subAgentDiscovery!: SubAgentDiscoveryResult;

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
	/** Single owner of turn state; see TurnPhase in types.ts and TurnStateMachine in turn-state.ts. */
	private readonly turnState = new TurnStateMachine((message, detail) =>
		log.logWarning(`[${this.channelId}] ${message}`, detail),
	);
	/** Set once transport-level `/new` replaces this generation. A retired runner is never reused. */
	private retired = false;
	/** When the primary model last failed and we switched to the backup. null = on primary. */
	private primaryFailedAt: number | null = null;

	// --- Per run ---
	private runState: RunState = createEmptyRunState();

	constructor(channelId: string, channelDir: string, paths: RunnerFactoryPaths, deps: RunnerDeps) {
		this.channelId = channelId;
		this.channelDir = channelDir;
		this.appHomeDir = paths.appHomeDir;
		this.authConfigPath = paths.authConfigPath;
		this.modelsConfigPath = paths.modelsConfigPath;
		this.onSessionEvent = paths.onSessionEvent;
		this.mediaSender = paths.mediaSender;

		this.executor = deps.executor;
		this.fileStore = deps.fileStore;
		this.loadSecurityConfig = deps.loadSecurityConfig;
		this.workspaceDir = resolve(dirname(channelDir));

		// Resolve and freeze this generation's ProjectScope (spec 043, D2/D3/D4.2). A channel with
		// no persisted selection gets the app default, materialized as its first selection right
		// here. A selection that no longer resolves safely (deleted directory, re-pointed symlink,
		// or a since-tightened allowlist) fails the whole runner closed rather than silently
		// falling back to a different root (P7) — the fix is `/project set`/`reset` from a plain
		// runtime command path, not a degraded-but-running channel; see project-scope-store.ts.
		const securityConfigForScope = this.loadSecurityConfig();
		const projectAccessResolution = resolveProjectAccessPolicy(securityConfigForScope.config, process.cwd());
		const scopeOutcome = resolveProjectScope(channelDir, projectAccessResolution);
		if (scopeOutcome.kind === "blocked") {
			throw new Error(`[${channelId}] Cannot start channel: ${scopeOutcome.reason}`);
		}
		this.projectScope = scopeOutcome.scope;

		// Initial skill summaries
		const initialSkills = loadPipiclawSkills(channelDir);
		this.currentSkills = initialSkills;

		// Create session manager, opening whichever session this channel's active-session ref
		// (or the context.jsonl default, for a channel that has never run a topology op) names
		// (spec 043, D1).
		const activeSessionFile = resolveActiveSessionFile(channelDir);
		this.sessionManager = SessionManager.open(join(channelDir, activeSessionFile), channelDir);

		// Per-runner recovery barrier (spec 043, D10 point 2): repairs must run against this exact
		// SessionManager instance, before anything else touches it — a second `open()` of the same
		// file would mutate a branch this instance never sees, silently desyncing the two. The
		// daemon's own startup scan (bootstrap.ts) covers channels with no live runner yet; this
		// covers lazy channels, the TUI, and a channel whose file was fixed by hand after the scan
		// already ran and reported it blocked.
		const recoveryOutcome = recoverInterruptedTurn(this.sessionManager, {
			api: defaultModel.api,
			provider: defaultModel.provider,
			model: defaultModel.id,
		});
		if (recoveryOutcome.kind === "blocked") {
			throw new Error(
				`[${channelId}] Cannot start channel: session left in an unrecoverable state after a restart (${recoveryOutcome.reason}). ` +
					`Back up ${join(channelDir, activeSessionFile)} on the host, move it aside, then use /new to start a fresh session.`,
			);
		}
		if (recoveryOutcome.kind === "repaired") {
			log.logWarning(
				`[${channelId}] Repaired an interrupted turn on restart`,
				`toolResults=${recoveryOutcome.appendedToolResults} abortedAssistant=${recoveryOutcome.appendedAbortedAssistant}`,
			);
		}
		this.settingsManager = paths.settingsManager;
		this.reportSettingsDiagnostics();
		this.memoryActivityRecorder = createMemoryActivityRecorder({
			appHomeDir: this.appHomeDir,
			onError: (channelId, error) =>
				log.logWarning(`[${channelId}] Failed to record memory maintenance state`, errorMessage(error)),
		});

		// The real model/auth runtime is built asynchronously in initializeSession
		// (ModelRuntime.create is async). Until then the agent runs on a placeholder
		// model; initializeSession corrects it before any turn (via sessionReady).
		this.activeModel = defaultModel;
		const initialTools = this.buildRuntimeTools();
		this.agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: this.activeModel,
				thinkingLevel: DEFAULT_MAIN_THINKING_LEVEL,
				tools: initialTools,
			},
			convertToLlm,
			getApiKey: async () => getApiKeyForModel(this.modelRegistry, this.activeModel),
			streamFn: streamSimple,
		});

		this.memoryLifecycle = new MemoryLifecycle({
			channelId: this.channelId,
			channelDir: this.channelDir,
			workspaceDir: this.workspaceDir,
			appHomeDir: this.appHomeDir,
			getMessages: () => this.session.messages,
			getSessionEntries: () => this.sessionManager.getBranch(),
			getModel: () => this.session.model ?? this.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			recordMemoryActivity: (event) => this.recordMemoryActivity(event),
		});

		this.sessionResourceGate = new SessionResourceGate(async () => {
			await this.reloadSessionResources();
		});

		this.sessionReady = this.initializeSession();
	}

	// === Public API ===

	beginTurn(taskText: string): void {
		this.turnState.begin(taskText);
	}

	endTurn(): void {
		this.turnState.end();
	}

	forceEndTurn(reason: string): boolean {
		return this.turnState.forceEnd(reason);
	}

	isBusy(): boolean {
		return this.turnState.isBusy();
	}

	requestStop(): void {
		this.turnState.requestStop();
	}

	getTurnStatus(): TurnStatus {
		return this.turnState.status();
	}

	async run(
		ctx: ChannelContext,
		store: ChannelStore,
	): Promise<{
		stopReason: string;
		errorMessage?: string;
		usage: UsageTotals;
		costKnown: boolean;
		durationMs: number;
		silent: boolean;
	}> {
		const startedAt = Date.now();
		this.resetRunState(ctx, store);
		// Direct callers (tests) may skip the transport's beginTurn/endTurn wrapper;
		// then run() owns the whole turn itself.
		const implicitTurn = !this.turnState.isBusy();
		if (implicitTurn) {
			this.beginTurn(ctx.message.text);
		}
		// Every later phase write goes through this reference: once `forceEndTurn`
		// has released this turn, the machine's current turn may already belong to the next one.
		const ownTurn = this.turnState.current();
		this.turnState.setPhase(ownTurn, "preparing");

		const runQueue = createRunQueue();
		this.runState.queue = runQueue.queue;
		let promptSubmitted = false;
		let fallbackAttempted = false;
		let fallbackTargetRef: string | undefined;
		// Hoisted so the debug dump in `finally` can report the turn as it was actually sent.
		let promptText = "";
		let taskDigestText = "";
		let durableMemoryBootstrapText = "";
		let channelCapsuleText = "";
		let bootstrapPrepared = false;

		try {
			await this.ensureSessionReady();
			await this.ensureMemoryMigrated();
			await this.maybeRestorePrimaryModel();
			this.memoryLifecycle.noteUserTurnStarted();
			const normalizedInputLength = ctx.message.text.replace(/\r/g, "").trim().length;
			let oversizedInputPath: string | undefined;
			if (normalizedInputLength > MAX_USER_MESSAGE_CHARS) {
				oversizedInputPath = await this.persistOversizedInput(ctx.message.text);
				await ctx.respondInThread(
					oversizedInputPath
						? `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理；完整内容已存到 \`${oversizedInputPath}\`，可以让我 read 该文件查看被省略的部分。`
						: `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理。`,
				);
			}
			const clippedInput = clipUserInput(ctx.message.text, MAX_USER_MESSAGE_CHARS, oversizedInputPath);
			const userMessage = this.formatUserMessage(clippedInput, ctx.message.userName);
			const preserveRawInput = this.shouldPreserveRawInput(ctx.message.text);

			// Ensure channel directory exists
			await mkdir(this.channelDir, { recursive: true });

			if (!preserveRawInput) {
				// Channel facts are turn-dynamic by design (spec 025 §7.3): keeping them out of the
				// system prompt is what lets every channel in a workspace share one cached prefix.
				channelCapsuleText = this.renderChannelTurnContext();

				// The task digest reads the whole tasks/ directory and depends on nothing the memory
				// bootstrap below produces, so it runs alongside it rather than queuing behind it.
				// Settled into a result object rather than left as a bare promise: if the bootstrap
				// throws first we would otherwise leave a rejection unobserved, which Node's default
				// policy turns into a process exit. Rethrown at the await, so a digest failure still
				// fails the turn exactly as it did when this ran inline.
				const taskDigestPromise = (this.tasksEnabled ? this.buildTaskDigestForTurn() : Promise.resolve("")).then(
					(text) => ({ text }) as { text: string; error?: never },
					(error: unknown) => ({ error }) as { text?: never; error: unknown },
				);

				// Spec 050, D1: the memory index is injected in full on the first turn of a session
				// (and the first turn after compaction — see `subscribeToSessionEvents`), never per
				// turn. Mid-session, the model uses `memory_search` to look things up.
				if (this.firstTurnMemoryBootstrapPending) {
					durableMemoryBootstrapText = await this.buildFirstTurnMemoryBootstrap();
					bootstrapPrepared = true;
				}

				const taskDigestResult = await taskDigestPromise;
				if (taskDigestResult.error !== undefined) {
					throw taskDigestResult.error;
				}
				taskDigestText = taskDigestResult.text ?? "";
			}

			const assembled = assembleTurnPrompt({
				clippedInput,
				userMessage,
				preserveRawInput,
				channelCapsule: channelCapsuleText,
				durableMemoryBootstrap: durableMemoryBootstrapText,
				taskDigest: taskDigestText,
			});
			promptText = assembled.text;

			// Resolved before the compaction estimate below (which needs the image count) and
			// refreshed inside `setModel` further down if a fallback switches models mid-turn
			// (spec 049 D7) — a model's image support is looked up here explicitly because the
			// SDK's own handling of an unsupported model is to silently replace each image block
			// with a text placeholder.
			let preparedImages = await this.prepareInboundImages(ctx.message.images);
			for (const notice of preparedImages.notices) {
				await ctx.respondInThread(notice);
			}

			// Estimated against the fully assembled prompt (recall + task digest + bootstrap all
			// included above), not just the bare user message — those pieces can add thousands of
			// characters and must count against the projected context usage this guard is checking.
			// Each image adds a fixed per-image estimate on top of the text: three attached photos
			// can by themselves push a turn over the threshold that would trigger this guard.
			await this.maybeRunPreventiveCompactionForIncomingText(promptText, preparedImages.images.length);

			this.lastTurnContextStats = assembled.stats;

			const fallbackDeps: FallbackRunDeps = {
				prompt: async (text) => {
					try {
						await this.sessionResourceGate.runPrompt(async () => {
							await this.session.prompt(
								text,
								preparedImages.images.length > 0 ? { images: preparedImages.images } : undefined,
							);
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
					await this.setModelWithThinkingPreservation(model);
					// The fallback model's vision support can differ from the one this turn started
					// on; re-resolve against it rather than resend whatever was prepared for the
					// model that just failed.
					preparedImages = await this.prepareInboundImages(ctx.message.images);
					for (const notice of preparedImages.notices) {
						await ctx.respondInThread(notice);
					}
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
			await this.finishTurn({
				ctx,
				ownTurn,
				implicitTurn,
				promptSubmitted,
				runQueue,
				fallbackAttempted,
				fallbackTargetRef,
				promptText,
				durableMemoryBootstrapText,
				taskDigestText,
			});
		}

		return {
			stopReason: this.runState.stopReason,
			errorMessage: this.runState.errorMessage,
			usage: { ...this.runState.totalUsage, cost: { ...this.runState.totalUsage.cost } },
			costKnown: this.runState.usageSources > 0 && this.runState.costKnown,
			durationMs: Date.now() - startedAt,
			silent: this.runState.finalOutcome.kind === "silent",
		};
	}

	/**
	 * The epilogue shared by every exit path out of `run()`'s try/catch: debug dump, delivery of
	 * whatever final message the turn settled on, usage/ledger accounting, the end-of-turn memory
	 * flush, and clearing run state. Pulled out of `run()` itself only to keep that method's main
	 * line (prepare → prompt with fallback) readable; every input here is `run()`-local, not
	 * instance state, so it is threaded through explicitly rather than promoted to a field.
	 */
	private async finishTurn(input: {
		ctx: ChannelContext;
		ownTurn: TurnHandle;
		implicitTurn: boolean;
		promptSubmitted: boolean;
		runQueue: ReturnType<typeof createRunQueue>;
		fallbackAttempted: boolean;
		fallbackTargetRef: string | undefined;
		promptText: string;
		durableMemoryBootstrapText: string;
		taskDigestText: string;
	}): Promise<void> {
		const { ctx, ownTurn, implicitTurn, promptSubmitted, runQueue, fallbackAttempted, fallbackTargetRef } = input;
		this.turnState.setPhase(ownTurn, "finishing");
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
				durableMemoryBootstrap: input.durableMemoryBootstrapText || undefined,
				taskDigest: input.taskDigestText || undefined,
				newUserMessage: input.promptText,
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
						this.runState.lastCompactionError && this.runState.lastCompactionError !== this.runState.errorMessage
							? this.runState.lastCompactionError.length > 240
								? `${this.runState.lastCompactionError.slice(0, 237)}...`
								: this.runState.lastCompactionError
							: undefined;
					const detailLines = [`\`${baseErrorSummary}\``];
					if (compactionSummary) {
						detailLines.push(`恢复尝试：\`${compactionSummary}\``);
					}
					if (fallbackAttempted && fallbackTargetRef) {
						detailLines.push(`已切换备用模型 \`${fallbackTargetRef}\` 重试，仍失败。`);
					}
					await ctx.replaceMessage(`_抱歉，出错了。_\n\n${detailLines.join("\n\n")}`);
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

		// Log usage summary. Gated on tokens as well as cost: a local (or pricing-less) model
		// bills nothing, and skipping it here left both the log and the ledger empty.
		if (this.runState.totalUsage.cost.total > 0 || this.runState.totalUsage.total > 0) {
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

		// The turn is over, so the channel is about to look idle to the maintenance gates —
		// which is exactly when this state has to be on disk. Everything buffered during the
		// turn lands here in one write.
		await this.flushMemoryActivity();

		// Clear run state
		this.runState.ctx = null;
		this.runState.logCtx = null;
		this.runState.queue = null;
		if (implicitTurn) {
			this.endTurn();
		}
	}

	async handleBuiltinCommand(ctx: ChannelContext, command: RunnerBuiltInCommand): Promise<void> {
		try {
			// `/help` and `/context` read `this.session` (prompt templates, active model).
			// The session runtime is built asynchronously after construction, so a command
			// that lands before it is ready would otherwise hit a TypeError (spec 048 F2).
			await this.ensureSessionReady();
			switch (command.name) {
				case "help":
					await this.sendCommandReply(ctx, this.renderHelpWithDiscovery(command.args), "help");
					return;
				case "context":
					await this.sendCommandReply(ctx, this.renderContextReport(command.args), "context");
					return;
				case "stop":
					await this.sendCommandReply(ctx, "当前没有运行中的回合，`/stop` 只在回合进行中有意义。", "stop");
					return;
				case "steer":
					this.requireQueuedMessage(command.args, "steer");
					await this.sendCommandReply(ctx, "当前没有运行中的回合，直接发消息即可，不用 `/steer`。", "steer");
					return;
				case "followup":
					this.requireQueuedMessage(command.args, "followup");
					await this.sendCommandReply(
						ctx,
						"当前没有运行中的回合，直接发消息即可；`/followup` 用于回合进行中排队。",
						"followup",
					);
					return;
				default: {
					// The stateless report commands (events/tasks/status/usage/subagents/project — see
					// `BUILT_IN_COMMANDS`'s `runnerHandled: false` entries) are routed to their own
					// handlers upstream and never reach here; the narrowed parameter type makes that a
					// compile-time guarantee.
					const _exhaustive: never = command.name;
					throw new Error(`Unhandled built-in command: ${String(_exhaustive)}`);
				}
			}
		} catch (err) {
			const errMsg = errorMessage(err);
			log.logWarning(`[${this.channelId}] Built-in command failed`, errMsg);
			await this.sendCommandReply(ctx, `命令执行失败：${errMsg}`, command.name);
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
		if (
			isKnownCommandName(
				name,
				this.currentSkills.skills.map((skill) => skill.name.toLowerCase()),
			)
		) {
			return true;
		}
		// Synchronous dispatch-path call: before the session runtime finishes building,
		// fall back to the static catalog + skills only. Misclassifying a prompt template
		// as "unknown" for the first few hundred ms after a runner is created is far
		// cheaper than throwing on the dispatch main path (spec 048 F2/D7).
		if (!this.sessionInitialized) {
			return false;
		}
		return this.session.promptTemplates.some((template) => template.name.toLowerCase() === name);
	}

	async queueSteer(text: string, userName?: string, images?: InboundImage[]): Promise<void> {
		await this.queueBusyMessage(this.requireQueuedMessage(text, "steer"), userName, images);
	}

	async flushMemoryForShutdown(): Promise<void> {
		await this.flushMemoryActivity();
		await this.memoryLifecycle.flushForShutdown();
	}

	async dispose(): Promise<void> {
		await this.flushMemoryForShutdown();
		if (this.isBusy()) {
			// `session.dispose()` aborts in-flight work; a busy runner keeps its session and
			// subscription until whoever holds it calls dispose() again once idle.
			log.logWarning(`[${this.channelId}] dispose() called while busy; session left intact`, "");
			return;
		}
		// Guards a dispose() racing construction: initializeSession assigns `this.session`
		// asynchronously, so a runner disposed the instant after creation may not have one yet.
		await this.sessionReady;
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = undefined;
		try {
			this.session.dispose();
		} catch (error) {
			log.logWarning(`[${this.channelId}] Session dispose failed`, errorMessage(error));
		}
	}

	async getMemoryMaintenanceContext(): Promise<MemoryMaintenanceRuntimeContext> {
		await this.ensureSessionReady();
		this.settingsManager.reload();
		return {
			channelId: this.channelId,
			channelDir: this.channelDir,
			workspaceDir: this.workspaceDir,
			// Snapshot only when a maintenance job actually needs the transcript; most ticks
			// stop at a schedule gate and never call these.
			messages: () => [...this.session.messages],
			sessionEntries: () => [...this.sessionManager.getBranch()],
			model: this.session.model ?? this.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			settings: { memoryMaintenance: this.settingsManager.getMemoryMaintenanceSettings() },
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

	isCompacting(): boolean {
		return this.session?.isCompacting ?? false;
	}

	interruptCompaction(): boolean {
		if (!this.session?.isCompacting) return false;
		this.session.abortCompaction();
		return true;
	}

	retireForNewSession(): void {
		if (this.retired) return;
		this.retired = true;
		if (this.session) {
			this.memoryLifecycle.noteNewSessionBoundary();
		}
		// close() marks the delivery context closed synchronously before awaiting its drain,
		// so late events from the old provider cannot overwrite the new session's response.
		void this.runState.ctx?.close().catch(() => undefined);
		this.forceEndTurn("superseded by /new");

		const retireLiveSession = (): void => {
			this.sessionUnsubscribe?.();
			this.sessionUnsubscribe = undefined;
			this.session.dispose();
		};
		if (this.session) {
			retireLiveSession();
		} else {
			// A second message can issue `/new` while this generation is still initializing.
			// Let construction settle in the background, then immediately tear it down.
			void this.sessionReady.then(retireLiveSession, () => undefined);
		}
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
			toolSchemas: measureToolSchemas(this.currentTools),
			soul: this.lastWorkspaceResources?.soul,
			agents: this.lastWorkspaceResources?.agents,
			lastTurn: this.lastTurnContextStats,
			detail: args.trim().toLowerCase() === "detail",
		});
	}

	/**
	 * `/help` — the static per-command listing from `commands.ts`, plus (top-level only) the
	 * prompt templates this session can actually invoke via `/<template-name>`. Workspace skills
	 * have their own dedicated command (`/skills`) and are deliberately not duplicated here.
	 * Prompt templates aren't knowable to `renderBuiltInHelp` itself (it is a pure function with
	 * no session state), so the runner appends them here (review 2026-08-24 §1.9).
	 */
	private renderHelpWithDiscovery(args: string): string {
		const help = renderBuiltInHelp(args);
		if (args.trim()) {
			return help;
		}
		const sections: string[] = [help];
		if (this.session.promptTemplates.length > 0) {
			sections.push(
				`**Prompt templates**\n\n${this.session.promptTemplates
					.map((template) => `- \`/${template.name}\``)
					.join("\n")}`,
			);
		}
		return sections.join("\n\n");
	}

	/** `/subagents list`'s role-directory health tail — whatever this runner already discovered. */
	getSubAgentDiscoverySnapshot(): SubAgentDiscoveryResult {
		return this.subAgentDiscovery;
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
			"The channel `MEMORY.md` index, `memory/`, `journal/` and `tasks/` live there. Prefer the context supplied with this turn and the channel-bound tools; read those files directly only when you need detail they did not provide.",
			"</runtime_turn_context>",
		].join("\n");
	}

	private async sendCommandReply(ctx: ChannelContext, text: string, commandName?: string): Promise<void> {
		// Command echoes are ephemeral control-plane traffic, not conversation: keep them out of
		// log.jsonl so they are never re-consumed as memory-extraction input (review 2026-08-24 §1.2).
		const title = commandName ? `/${commandName}` : undefined;
		const delivered = await ctx.respondPlain(text, false, title);
		if (!delivered) {
			await ctx.replaceMessage(text);
			await ctx.flush();
		}
	}

	/**
	 * Buffer one activity event. The write itself is batched by the recorder (see
	 * `createMemoryActivityRecorder`); `run()` flushes at the end of every turn, which is the
	 * point the maintenance gates actually start looking at this state.
	 */
	private recordMemoryActivity(event: MemoryActivityEvent): void {
		const maintenanceSettings = this.settingsManager.getMemoryMaintenanceSettings();
		const eventTime = parseLocalTime(event.timestamp);
		const eligibleAfter =
			eventTime !== undefined
				? formatLocalTime(
						new Date(eventTime + Math.max(0, maintenanceSettings.minIdleMinutesBeforeLlmWork) * 60_000),
					)
				: undefined;
		this.memoryActivityRecorder.record({ ...event, eligibleAfter });
	}

	/** Best-effort: a lost activity counter delays maintenance, it never breaks a turn. */
	private async flushMemoryActivity(): Promise<void> {
		try {
			await this.memoryActivityRecorder.flush(this.channelId);
		} catch (error) {
			log.logWarning(`[${this.channelId}] Failed to flush memory maintenance state`, errorMessage(error));
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

	/**
	 * Save a message that exceeds the per-turn input budget so its clipped middle stays reachable.
	 *
	 * Pasting a long build log or diff is a normal way to start driving work here, and the clip
	 * keeps head and tail — which is where the failing frames usually are *not*. Landing the
	 * original under the channel directory puts it inside the paths `read` already allows, so
	 * recovery is the ordinary paging path rather than a special case.
	 *
	 * Best-effort: if the write fails the turn still runs on the clipped text, just without a
	 * pointer.
	 */
	private async persistOversizedInput(text: string): Promise<string | undefined> {
		try {
			const dir = join(this.channelDir, "inbox");
			await mkdir(dir, { recursive: true });
			const path = join(dir, `message-${localStampForFilename()}.txt`);
			await writeFile(path, text.replace(/\r/g, ""), { mode: 0o600 });
			return path;
		} catch (error) {
			log.logWarning("Could not persist oversized user message", errorMessage(error));
			return undefined;
		}
	}

	private formatUserMessage(text: string, userName?: string, now: Date = new Date()): string {
		return `[${formatLocalTime(now)}] [${userName || "unknown"}]: ${text}`;
	}

	/**
	 * Turn `InboundImage`s (already downloaded and persisted by the transport, spec 049) into the
	 * `ImageContent[]` `AgentSession.prompt`/`steer` accept, plus any notices to surface to the
	 * user about images that did not make it into this turn.
	 *
	 * Two gates apply, both fail *open* toward "still deliver the message" rather than dropping
	 * the whole turn over one bad attachment:
	 *
	 * - The current model's `input` capability (spec 049 D7). A model that does not declare
	 *   `"image"` support has its image blocks silently replaced with a text placeholder by the
	 *   SDK's provider layer — exactly the failure this spec exists to fix, so it is checked
	 *   explicitly here rather than trusted to fail loudly on its own. Re-checked on every call
	 *   (including a mid-turn steer after a model fallback), since a fallback model's capability
	 *   can differ from the one the turn started with.
	 * - A defense-in-depth size re-check against `MAX_INBOUND_IMAGE_BYTES`. The transport already
	 *   enforces this at download time, but the check is cheap and free of assumptions about how
	 *   an `InboundImage` reached this method.
	 *
	 * An image already marked `unsupportedFormat` (sniffing failed at download time) is skipped
	 * without its own notice — the `[图片N：格式不支持，已保存]` marker already in the message text
	 * covers it.
	 */
	private async prepareInboundImages(
		images: InboundImage[] | undefined,
	): Promise<{ images: ImageContent[]; notices: string[] }> {
		if (!images || images.length === 0) {
			return { images: [], notices: [] };
		}

		const model = this.session.model ?? this.activeModel;
		if (!model.input.includes("image")) {
			const modelRef = formatModelReference(model);
			return {
				images: [],
				notices: [
					`⚠️ 当前模型 ${modelRef} 不支持图片输入，收到的图片已保存但未加入本轮上下文：\n` +
						images.map((image) => `- \`${image.path}\``).join("\n") +
						"\n可以切换到支持视觉的模型后让我 read 该文件。",
				],
			};
		}

		const contents: ImageContent[] = [];
		const notices: string[] = [];
		for (const image of images) {
			if (image.unsupportedFormat) continue;
			if (image.byteSize > MAX_INBOUND_IMAGE_BYTES) {
				notices.push(
					`⚠️ 图片 \`${image.path}\`（${formatSize(image.byteSize)}）超过 ${formatSize(MAX_INBOUND_IMAGE_BYTES)} 上限，未加入本轮上下文，可以让我 read 该文件查看。`,
				);
				continue;
			}
			try {
				const data = await readFile(image.path);
				contents.push({ type: "image", data: data.toString("base64"), mimeType: image.mimeType });
			} catch (error) {
				notices.push(`⚠️ 图片 \`${image.path}\` 读取失败：${errorMessage(error)}`);
			}
		}
		return { images: contents, notices };
	}

	/**
	 * Single source of truth for the busy-message window: steer is accepted while
	 * the prompt is being assembled ("preparing") or while the agent loop is
	 * actually streaming. Re-asserted after every await because the turn can end
	 * while this call was suspended.
	 */
	private assertBusyWindowOpen(): void {
		if (this.turnState.phase() === "preparing") {
			return;
		}
		if (this.turnState.phase() === "streaming" && this.session.isStreaming) {
			return;
		}
		throw new Error("No task is currently running.");
	}

	private async queueBusyMessage(text: string, userName?: string, images?: InboundImage[]): Promise<void> {
		this.assertBusyWindowOpen();

		await this.ensureSessionReady();

		const oversized = text.replace(/\r/g, "").trim().length > MAX_USER_MESSAGE_CHARS;
		const oversizedPath = oversized ? await this.persistOversizedInput(text) : undefined;
		const clippedText = clipUserInput(text, MAX_USER_MESSAGE_CHARS, oversizedPath);
		if (oversized) {
			log.logWarning(`[${this.channelId}] Queued message exceeded ${MAX_USER_MESSAGE_CHARS} chars and was clipped`);
		}
		const queuedMessage = this.formatUserMessage(clippedText, userName);
		const preparedImages = await this.prepareInboundImages(images);
		for (const notice of preparedImages.notices) {
			await this.runState.ctx?.respondInThread(notice);
		}
		await this.maybeRunPreventiveCompactionForIncomingText(queuedMessage, preparedImages.images.length);

		this.assertBusyWindowOpen();

		const queueMessage = async () => {
			this.assertBusyWindowOpen();
			await this.session.steer(queuedMessage, preparedImages.images.length > 0 ? preparedImages.images : undefined);
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
			await this.setModelWithThinkingPreservation(this.activeModel);
			this.primaryFailedAt = null;
			log.logInfo(`[${this.channelId}] Restored primary model ${formatModelReference(this.activeModel)}`);
		} catch (err) {
			log.logWarning(`[${this.channelId}] Failed to restore primary model`, errorMessage(err));
		}
	}

	private async setModelWithThinkingPreservation(model: Model<Api>): Promise<void> {
		await setModelWithThinkingPreservation(this.session, this.sessionSettingsManager, model);
	}

	private setThinkingLevelCompat(level: ThinkingLevel): void {
		setThinkingLevelWithConditionalPersist(this.session, level);
	}

	private cycleThinkingLevelCompat(): ThinkingLevel | undefined {
		return cycleThinkingLevelWithConditionalPersist(this.session);
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
		await this.modelRegistry.refresh();
		const available = this.modelRegistry.getAvailable();
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
		// Build the canonical async model/auth runtime and its synchronous read shell.
		this.modelRuntime = await createModelRuntime({
			authConfigPath: this.authConfigPath,
			modelsConfigPath: this.modelsConfigPath,
		});
		this.modelRegistry = wrapModelRegistry(this.modelRuntime);

		// Resolve model: prefer saved global default, fall back to first available model.
		this.activeModel = resolveInitialModel(this.modelRegistry, this.settingsManager);
		this.agent.state.model = this.activeModel; // correct the placeholder default
		this.initializeThinkingLevel(this.agent, this.activeModel, this.sessionManager);
		log.logInfo(`Using model: ${this.activeModel.provider}/${this.activeModel.id} (${this.activeModel.name})`);
		this.subAgentDiscovery = await this.refreshSubAgentDiscovery();

		const initialResourceLoader = this.createResourceLoader();
		const baseToolsOverride = Object.fromEntries(this.currentTools.map((tool) => [tool.name, tool]));
		this.sessionSettingsManager = asSdkSettingsManager(this.settingsManager);
		this.session = new AgentSession({
			agent: this.agent,
			sessionManager: this.sessionManager,
			settingsManager: this.sessionSettingsManager,
			cwd: this.projectScope.projectRoot,
			modelRuntime: this.modelRuntime,
			resourceLoader: initialResourceLoader,
			baseToolsOverride,
		});
		this.sessionRuntime = new AgentSessionRuntime(
			this.session,
			this.createAgentSessionServices(initialResourceLoader),
			async ({ sessionManager, sessionStartEvent }) => {
				// `/new`, fork, and switch already wrote the target session's durable header by
				// this point (the SDK does it synchronously before invoking this callback); commit
				// the pointer before we rebuild and rebind to it, so a crash between "SDK created
				// session" and "we finished rebinding" leaves the old ref (and old session)
				// authoritative rather than an orphaned new file (spec 043, D1.3).
				await commitActiveSessionRef(this.channelDir, sessionManager);
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

		// Subscribe to session events
		this.subscribeToSessionEvents();

		await this.reloadSessionResources();
		await this.bindSessionExtensions();
		this.sessionInitialized = true;
	}

	private async reloadSessionResources(): Promise<void> {
		this.settingsManager.reload();
		this.reportSettingsDiagnostics();
		const skills = loadPipiclawSkills(this.channelDir);
		this.currentSkills = skills;
		this.subAgentDiscovery = await this.refreshSubAgentDiscovery();
		this.rebuildSessionTools();
		try {
			await withTimeout(`[${this.channelId}] session reload`, SESSION_RELOAD_TIMEOUT_MS, () =>
				this.session.reload(),
			);
		} catch (error) {
			log.logWarning(`[${this.channelId}] Session reload did not settle`, errorMessage(error));
		}
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

	/** Spec 050 §5: migrate this channel's memory to v2 on first use, before any turn reads it. */
	private memoryMigrationChecked = false;
	private async ensureMemoryMigrated(): Promise<void> {
		if (this.memoryMigrationChecked) {
			return;
		}
		this.memoryMigrationChecked = true;
		if (isChannelMigratedToV2(this.channelDir)) {
			return;
		}
		try {
			const result = await migrateChannelMemoryToV2(this.channelDir);
			if (result.migrated) {
				log.logInfo(
					`[${this.channelId}] Migrated channel memory to v2 (${result.entries} entries, ${result.journalDays} journal days)`,
				);
			}
		} catch (error) {
			log.logWarning(`[${this.channelId}] Channel memory v2 migration failed`, errorMessage(error));
		}
	}

	private async maybeRunPreventiveCompactionForIncomingText(
		incomingText: string,
		imageCount: number = 0,
	): Promise<void> {
		const currentModel = this.session.model ?? this.activeModel;
		const contextUsage = this.session.getContextUsage();
		const contextTokens = contextUsage?.tokens;
		const incomingTokens = estimateIncomingMessageTokens(incomingText, imageCount);
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

	private async refreshSubAgentDiscovery(): Promise<SubAgentDiscoveryResult> {
		// Re-resolves models.json *and* every provider's auth, which for an OAuth
		// provider is a network call. Failing open keeps the last known model
		// snapshot — stale availability is a far smaller problem than a reload
		// (and, through it, a `/new` turn) that never returns.
		try {
			await withTimeout(`[${this.channelId}] model registry refresh`, MODEL_REGISTRY_REFRESH_TIMEOUT_MS, () =>
				this.modelRegistry.refresh(),
			);
		} catch (error) {
			log.logWarning(
				`[${this.channelId}] Model registry refresh did not settle; using the previous model snapshot`,
				errorMessage(error),
			);
		}
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
			cwd: this.projectScope.projectRoot,
			workspaceDir: this.workspaceDir,
			tools: this.currentTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
			})),
			soul: resources.soul,
			agents: resources.agents,
			playbooks: selectRuntimePlaybooks(loadRuntimePlaybookCatalog(), toolNames),
			subAgents: this.subAgentDiscovery.agents.map((agent) => ({
				name: agent.name,
				description: agent.description,
				runtime: agent.runtime,
				harness: agent.harness,
				workload: agent.workload ?? (agent.runtime === "external" ? "heavy" : "light"),
				mutates: agent.mutates,
				unavailable: agent.unavailable,
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
			cwd: this.projectScope.projectRoot,
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
						await this.modelRegistry.refresh();
						return this.modelRegistry.getAvailable();
					},
					getSessionStats: () => this.session.getSessionStats(),
					getThinkingLevel: () => this.session.thinkingLevel,
					getAvailableThinkingLevels: () => this.session.getAvailableThinkingLevels(),
					setThinkingLevel: (level) => this.setThinkingLevelCompat(level),
					cycleThinkingLevel: () => this.cycleThinkingLevelCompat(),
					getLastResponseModel: () => getLastAssistantUsage(this.session.messages)?.responseModel,
					switchModel: async (model) => {
						await this.setModelWithThinkingPreservation(model);
						this.activeModel = model;
						// Manual /model switch redefines the preferred model and clears fallback state.
						this.primaryFailedAt = null;
					},
					refreshSessionResources: async () => {
						await this.refreshSessionResources();
					},
					runMemoryCommand: async (args) =>
						handleMemoryCommand({
							channelId: this.channelId,
							channelDir: this.channelDir,
							appHomeDir: this.appHomeDir,
							args,
						}),
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
			cwd: this.projectScope.projectRoot,
			agentDir: this.appHomeDir,
			settingsManager: asSdkSettingsManager(this.settingsManager),
			modelRuntime: this.modelRuntime,
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

	/**
	 * Resolve the initial thinking level using the same precedence as pi's SDK:
	 * session history, configured default, then medium. The effective value is
	 * clamped to the selected model before the session starts.
	 */
	private initializeThinkingLevel(agent: Agent, model: Model<Api>, sessionManager: SessionManager): void {
		initializeThinkingLevelCompat(agent, model, sessionManager, this.settingsManager.getDefaultThinkingLevel());
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
				thinkingLevel: DEFAULT_MAIN_THINKING_LEVEL,
				tools,
			},
			convertToLlm,
			getApiKey: async () => getApiKeyForModel(this.modelRegistry, this.activeModel),
			streamFn: streamSimple,
		});
		this.initializeThinkingLevel(agent, this.activeModel, sessionManager);
		const resourceLoader = this.createResourceLoader();
		const sessionSettingsManager = asSdkSettingsManager(this.settingsManager);
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: sessionSettingsManager,
			cwd: this.projectScope.projectRoot,
			modelRuntime: this.modelRuntime,
			resourceLoader,
			baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
			sessionStartEvent,
		});
		this.sessionSettingsManager = sessionSettingsManager;
		return { agent, session, resourceLoader };
	}

	private buildRuntimeTools(): AgentTool<any>[] {
		const securityLoad = this.loadSecurityConfig();
		const toolsLoad = loadToolsConfigWithDiagnostics(this.appHomeDir);
		this.reportConfigDiagnostics([...securityLoad.diagnostics, ...toolsLoad.diagnostics]);
		this.tasksEnabled = toolsLoad.config.tools.tasks.enabled;

		const tools = createPipiclawTools({
			executor: this.executor,
			fileStore: this.fileStore,
			getCurrentModel: () => this.activeModel,
			getAvailableModels: () => this.modelRegistry.getAvailable(),
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			workspaceDir: this.workspaceDir,
			projectScope: this.projectScope,
			channelDir: this.channelDir,
			channelId: this.channelId,
			getSubAgentDiscovery: () => this.subAgentDiscovery,
			getSubAgentModelReference: () => this.settingsManager.getSubAgentModelReference(),
			getSessionSearchSettings: () => this.settingsManager.getSessionSearchSettings(),
			securityConfig: securityLoad.config,
			toolsConfig: toolsLoad.config,
			mediaSender: this.mediaSender,
		});
		this.currentTools = tools;
		// Tool schemas are billed with the system prompt and, unlike it, nothing trims them.
		// Warn where the prompt's own budget diagnostics are reported, once per tool rebuild.
		const schemas = measureToolSchemas(tools);
		if (schemas.units > TOOL_SCHEMA_TARGET_UNITS) {
			log.logWarning(`[${this.channelId}] Tool schema budget`, toolSchemaBudgetWarning(schemas));
		}
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
			// Observation is deliberately before our consumer and must never alter a turn.
			try {
				this.onSessionEvent?.(event, this.channelId);
			} catch (err) {
				log.logWarning(`[${this.channelId}] session observer failed`, errorMessage(err));
			}
			if (isRecord(event) && event.type === "message_start") {
				this.turnState.markStreaming();
			}
			if (isRecord(event) && "reason" in event && event.reason === "new") {
				this.firstTurnMemoryBootstrapPending = true;
			}
			// Spec 050, D1: compaction rewrites the first-turn bootstrap into a summary; re-inject
			// the authoritative index on the next turn so memory does not decay with the transcript.
			if (isAutoCompactionEndEvent(event) && !event.aborted && !event.errorMessage) {
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
				isModelCostKnown: (reference) => {
					const model = findExactModelReferenceMatch(reference, this.modelRegistry.getAvailable()).match;
					return model ? hasKnownModelPricing(model) : false;
				},
				refreshSessionResources: async () => {
					await this.refreshSessionResources();
				},
				skillsDir: join(this.workspaceDir, "skills"),
			}).catch((err) => {
				log.logWarning(`[${this.channelId}] session event handler failed`, errorMessage(err));
			});
		});
	}

	/** Gated by the same master autonomy switch as the task_* tools and the TaskDriver. */
	private buildTaskDigestForTurn(): Promise<string> {
		return buildTaskDigest({
			channelDir: this.channelDir,
			maxTasks: TASK_DIGEST_SETTINGS.maxTasks,
			maxChars: TASK_DIGEST_SETTINGS.maxChars,
			maxUnits: TASK_AGENDA_MAX_UNITS,
		});
	}

	/**
	 * Spec 050, D1: assemble `<memory_bootstrap>` for the first turn of a session — workspace
	 * MEMORY.md (whole H2 sections, budgeted) + the channel index (full, or budget-tiered). The
	 * journal subsection is added in P2.
	 */
	private async buildFirstTurnMemoryBootstrap(): Promise<string> {
		const readOptionalFile = async (path: string): Promise<string> => {
			try {
				return await readFile(path, "utf-8");
			} catch {
				return "";
			}
		};

		const today = localDayKey();
		const [entries, workspaceMemory, journalToday] = await Promise.all([
			listMemoryEntries(this.channelDir).catch(() => []),
			readOptionalFile(join(this.workspaceDir, "MEMORY.md")),
			readJournalDay(this.channelDir, today).catch(() => ""),
		]);

		const index = buildChannelIndexForBootstrap(entries);
		const journalTail = clipJournalTailForBootstrap(journalToday);
		return renderMemoryBootstrap({
			workspaceMemory: clipWorkspaceMemoryForBootstrap(workspaceMemory),
			channelIndex: entries.length > 0 ? index.text : "",
			journal: journalTail ? { date: today, text: journalTail } : undefined,
		});
	}
}
