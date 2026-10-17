/**
 * The SDK session of one channel: building and rebuilding it (resource loader, tools, system prompt,
 * extensions), subscribing to its events, binding it to a task's own session or back to the chat
 * session, and tearing it down. Owns the session-side state — the session itself, the model
 * runtime and registry, the current tools and skills, the last prompt build — and nothing about
 * turns; `ChannelRunner` drives turns through it.
 */
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	AgentSession,
	AgentSessionRuntime,
	type AgentSessionServices,
	convertToLlm,
	DefaultResourceLoader,
	type ModelRegistry,
	type ModelRuntime,
	type ResourceLoader,
	type SettingsManager as SDKSettingsManager,
	type SessionManager,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdir } from "fs/promises";
import { dirname, join } from "path";
import { commitActiveSessionRef, resolveActiveSessionFile } from "../../channel/active-session-store.js";
import type { MediaSender } from "../../channel/channel-context.js";
import type { PipiclawSettingsManager } from "../../config/settings.js";
import { loadToolsConfigWithDiagnostics } from "../../config/tools.js";
import type { Executor } from "../../executor.js";
import type { FileStore } from "../../file-store.js";
import type { ChannelJobManager } from "../../jobs/manager.js";
import * as log from "../../log.js";
import { handleMemoryCommand } from "../../memory/commands.js";
import type { MemoryLifecycle } from "../../memory/lifecycle.js";
import { hasMemoryBootstrapBlock } from "../../memory/render.js";
import { getApiKeyForModel } from "../../models/api-keys.js";
import { findExactModelReferenceMatch, hasKnownModelPricing } from "../../models/reference.js";
import { createModelRuntime, resolveInitialModel, wrapModelRegistry } from "../../models/runtime.js";
import type { LoadedSecurityConfig } from "../../security/config.js";
import { type ConfigDiagnostic, formatConfigDiagnostic } from "../../shared/config-diagnostic.js";
import { errorMessage } from "../../shared/text-utils.js";
import { isRecord } from "../../shared/type-guards.js";
import { withTimeout } from "../../shared/with-timeout.js";
import { loadPipiclawSkills, type PipiclawSkillsResult, resolvePipiclawSkills } from "../../skills/loader.js";
import { discoverSubAgents, type SubAgentDiscoveryResult } from "../../subagents/discovery.js";
import type { SubAgentRunManager } from "../../subagents/runs.js";
import { TASK_SESSIONS_DIRNAME, taskSessionPath } from "../../tasks/session-path.js";
import { createPipiclawTools } from "../../tools/index.js";
import type { UsageLedger } from "../../usage/ledger.js";
import { buildPipiclawSystemPrompt } from "../prompt/builder.js";
import { createPromptBoundaryExtension } from "../prompt/extension.js";
import { measureToolSchemas, TOOL_SCHEMA_TARGET_UNITS, toolSchemaBudgetWarning } from "../prompt/manifest.js";
import { loadPlaybooks, loadWorkspacePromptResources, type WorkspacePromptResources } from "../prompt/resources.js";
import type { PromptBuildResult } from "../prompt/types.js";
import type { RunState } from "../types.js";
import { createCommandExtension } from "./command-extension.js";
import { getLastAssistantUsage, isAutoCompactionEndEvent } from "./event-guards.js";
import type { ModelSelection } from "./model-selection.js";
import {
	asSdkSettingsManager,
	DEFAULT_MAIN_THINKING_LEVEL,
	initializeThinkingLevelCompat,
	setSessionBaseToolsOverride,
} from "./session-adapter.js";
import { handleSessionEvent } from "./session-events.js";
import { SessionResourceGate } from "./session-resource-gate.js";

const MODEL_REGISTRY_REFRESH_TIMEOUT_MS = 15_000;
const SESSION_RELOAD_TIMEOUT_MS = 30_000;
const CONTEXT_FAULT_MESSAGE = "会话上下文保存失败。请让部署者检查服务器存储后发送 /new 重新开启会话。";

/** The text of a message's `content`, whether it is a bare string or a multimodal part array. */
function plainTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("\n");
}

/** Task sessions live under `<dotDir>/tasks/.sessions/`; nothing else may be mistaken for one. */
function isTaskSessionPath(sessionFile: string | undefined): boolean {
	return sessionFile?.replace(/\\/g, "/").includes(`/${TASK_SESSIONS_DIRNAME}/`) === true;
}

/** Surface settings.json load errors (once drained) as warnings; shared by construction and reload. */
export function reportSettingsDiagnostics(
	settingsManager: PipiclawSettingsManager,
	channelId: string,
	appHomeDir: string,
): void {
	for (const { scope, error } of settingsManager.drainErrors()) {
		log.logWarn("config.settings.load_failed", "Settings load failed", {
			channelId,
			reason: error.message,
			fields: { scope, path: join(appHomeDir, "settings.json") },
		});
	}
}

export interface SessionHostDeps {
	channelId: string;
	dotDir: string;
	workspaceDir: string;
	appHomeDir: string;
	authConfigPath: string;
	modelsConfigPath: string;
	onSessionEvent?: (event: unknown, channelId: string) => void;
	mediaSender?: MediaSender;
	/** The agent's working directory: SDK session and resource-loader cwd, and the tools' relative-path base. */
	cwd: string;
	settingsManager: PipiclawSettingsManager;
	/** Re-read per use, not captured once: an edited security.json takes effect without a restart. */
	loadSecurityConfig: () => LoadedSecurityConfig;
	executor: Executor;
	fileStore: FileStore;
	jobManager: ChannelJobManager;
	runManager: SubAgentRunManager;
	memoryLifecycle: MemoryLifecycle;
	models: ModelSelection;
	ledger: UsageLedger;
	/** Skill summaries loaded at construction, before the session exists. */
	initialSkills: PipiclawSkillsResult;
	/** The current run's state (replaced by the runner at the start of every run). */
	getRunState: () => RunState;
	/** The agent loop started streaming: steer is now accepted into the session. */
	markStreaming: () => void;
}

export class SessionHost {
	private readonly channelId: string;
	private readonly dotDir: string;
	private readonly workspaceDir: string;
	private readonly appHomeDir: string;
	private readonly authConfigPath: string;
	private readonly modelsConfigPath: string;
	private readonly onSessionEvent?: (event: unknown, channelId: string) => void;
	private readonly mediaSender?: MediaSender;
	private readonly cwd: string;
	private readonly settingsManager: PipiclawSettingsManager;
	private readonly loadSecurityConfig: () => LoadedSecurityConfig;
	private readonly executor: Executor;
	private readonly fileStore: FileStore;
	private readonly jobManager: ChannelJobManager;
	private readonly runManager: SubAgentRunManager;
	private readonly memoryLifecycle: MemoryLifecycle;
	private readonly models: ModelSelection;
	private readonly ledger: UsageLedger;

	session!: AgentSession;
	/** Settings manager owned by the currently bound AgentSession. */
	sessionSettingsManager!: SDKSettingsManager;
	// modelRuntime is the canonical async model/auth facade (pi 0.80.8+); modelRegistry
	// is the synchronous read shell wrapped over it. Both are assigned in initializeSession
	// because ModelRuntime.create is async, so a placeholder model is used until then.
	private modelRuntime!: ModelRuntime;
	modelRegistry!: ModelRegistry;
	/** Mutual exclusion between prompt submission and session-resource reloads. */
	private readonly sessionResourceGate: SessionResourceGate;
	sessionReady!: Promise<void>;
	/**
	 * Flips true only once `initializeSession` has fully assigned `this.session`
	 * and loaded its resources. Synchronous dispatch-path callers (`isKnownSlashCommand`)
	 * must not touch `this.session` before this — the model runtime takes hundreds
	 * of ms to build and the first message can arrive first (spec 048 F2).
	 */
	sessionInitialized = false;
	private sessionRuntime!: AgentSessionRuntime;
	sessionUnsubscribe?: () => void;
	subAgentDiscovery!: SubAgentDiscoveryResult;
	currentSkills: PipiclawSkillsResult;
	/** Last built system prompt (spec 025): feeds the boundary footer, /context and the debug manifest. */
	lastPromptBuild?: PromptBuildResult;
	/** SOUL/AGENTS as resolved for the last build, for the `/context` independent-budget lines. */
	lastWorkspaceResources?: WorkspacePromptResources;
	/** The exact system prompt the provider last received (our prompt + pi's tail + footer). */
	lastFinalPrompt?: string;
	currentTools: AgentTool<any>[] = [];
	firstTurnMemoryBootstrapPending = true;
	/** Mirror of `tools.tasks.enabled` from the last tools-config load (see buildRuntimeTools). */
	tasksEnabled = true;
	/**
	 * Set while this runner is bound to a task's own session (spec 051, D3). Turns are serialized
	 * per channel, so one runner can carry both surfaces by swapping which session file it is
	 * bound to between turns — which keeps busy state, `/stop`, steering and turn recovery with
	 * their existing single owner instead of splitting them across two runner instances.
	 */
	taskLoop?: { taskId: string };

	constructor(private readonly deps: SessionHostDeps) {
		this.channelId = deps.channelId;
		this.dotDir = deps.dotDir;
		this.workspaceDir = deps.workspaceDir;
		this.appHomeDir = deps.appHomeDir;
		this.authConfigPath = deps.authConfigPath;
		this.modelsConfigPath = deps.modelsConfigPath;
		this.onSessionEvent = deps.onSessionEvent;
		this.mediaSender = deps.mediaSender;
		this.cwd = deps.cwd;
		this.settingsManager = deps.settingsManager;
		this.loadSecurityConfig = deps.loadSecurityConfig;
		this.executor = deps.executor;
		this.fileStore = deps.fileStore;
		this.jobManager = deps.jobManager;
		this.runManager = deps.runManager;
		this.memoryLifecycle = deps.memoryLifecycle;
		this.models = deps.models;
		this.ledger = deps.ledger;
		this.currentSkills = deps.initialSkills;
		this.sessionResourceGate = new SessionResourceGate(async () => {
			await this.reloadSessionResources();
		});
	}

	private get runState(): RunState {
		return this.deps.getRunState();
	}

	get agent(): Agent {
		return this.session.agent;
	}

	get sessionManager(): SessionManager {
		return this.session.sessionManager;
	}

	/** Kick off asynchronous session construction. The first message can arrive before it settles. */
	start(sessionManager: SessionManager): void {
		this.sessionReady = this.initializeSession(sessionManager);
	}

	private readonly contextFaults = new WeakSet<AgentSession>();

	markContextFault(session: AgentSession, error: unknown): Error {
		this.contextFaults.add(session);
		log.logWarn("agent.session.context_failed", "Session context persistence failed", {
			channelId: this.channelId,
			reason: errorMessage(error),
			fields: { sessionId: session.sessionManager.getSessionId(), stage: "fallback-context-edit" },
		});
		return new Error(CONTEXT_FAULT_MESSAGE, { cause: error });
	}

	assertContextHealthy(): void {
		if (this.contextFaults.has(this.session)) throw new Error(CONTEXT_FAULT_MESSAGE);
	}

	/** Run a prompt (or steer) with the resource gate and the context-fault guard. */
	runPrompt<T>(fn: () => Promise<T>): Promise<T> {
		return this.sessionResourceGate.runPrompt(async () => {
			this.assertContextHealthy();
			return fn();
		});
	}

	/** Stop listening to the live session and dispose it (no-op error handling is the caller's). */
	retireLiveSession(): void {
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = undefined;
		this.session.dispose();
	}

	/**
	 * Release the session once idle. Guards a dispose() racing construction: initializeSession
	 * assigns `this.session` asynchronously, so a runner disposed the instant after creation may
	 * not have one yet.
	 */
	async disposeSession(): Promise<void> {
		await this.sessionReady;
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = undefined;
		try {
			this.session.dispose();
		} catch (error) {
			log.logWarn("agent.session.dispose_failed", "Session dispose failed", {
				channelId: this.channelId,
				reason: errorMessage(error),
			});
		}
	}

	async refreshSessionResources(): Promise<void> {
		await this.ensureSessionReady();
		await this.sessionResourceGate.requestRefresh();
	}

	private async initializeSession(sessionManager: SessionManager): Promise<void> {
		// Build the canonical async model/auth runtime and its synchronous read shell.
		this.modelRuntime = await createModelRuntime({
			authConfigPath: this.authConfigPath,
			modelsConfigPath: this.modelsConfigPath,
		});
		this.modelRegistry = wrapModelRegistry(this.modelRuntime);

		// Resolve model: prefer saved global default, fall back to first available model.
		this.models.activeModel = resolveInitialModel(this.modelRegistry, this.settingsManager);
		log.logInfo(
			`Using model: ${this.models.activeModel.provider}/${this.models.activeModel.id} (${this.models.activeModel.name})`,
		);
		this.subAgentDiscovery = await this.refreshSubAgentDiscovery();

		const initial = await this.createSessionRuntime(sessionManager);
		this.session = initial.session;
		this.sessionRuntime = new AgentSessionRuntime(
			this.session,
			this.createAgentSessionServices(initial.resourceLoader),
			async ({ sessionManager, sessionStartEvent }) => {
				// `/new`, fork, and switch already wrote the target session's durable header by
				// this point (the SDK does it synchronously before invoking this callback); commit
				// the pointer before we rebuild and rebind to it, so a crash between "SDK created
				// session" and "we finished rebinding" leaves the old ref (and old session)
				// authoritative rather than an orphaned new file (spec 043, D1.3).
				// A task session is not the channel's chat session: never repoint the active-session
				// ref at it, or `/new` and restart recovery would adopt a task's transcript as the
				// conversation (spec 051, D3).
				if (!isTaskSessionPath(sessionManager.getSessionFile())) {
					await commitActiveSessionRef(this.dotDir, sessionManager);
				}
				const next = await this.createSessionRuntime(sessionManager, sessionStartEvent);
				return {
					session: next.session,
					extensionsResult: next.resourceLoader.getExtensions(),
					services: this.createAgentSessionServices(next.resourceLoader),
					diagnostics: [],
				};
			},
		);
		this.sessionRuntime.setRebindSession(async (session) => {
			this.session = session;
			await this.bindSessionExtensions();
			this.subscribeToSessionEvents();
		});

		// Subscribe to session events
		this.subscribeToSessionEvents();

		await this.bindSessionExtensions();
		// A restart resumes an existing transcript: if that session was already handed its
		// bootstrap before the daemon went down, the first turn after recovery must not inject a
		// second copy just because a process-local field starts out `true`.
		this.syncMemoryBootstrapPendingFromSession();
		this.sessionInitialized = true;
	}

	private async reloadSessionResources(): Promise<void> {
		this.settingsManager.reload();
		this.reportSettingsDiagnostics();
		const skills = loadPipiclawSkills(this.dotDir);
		this.currentSkills = skills;
		this.subAgentDiscovery = await this.refreshSubAgentDiscovery();
		this.rebuildSessionTools();
		try {
			await withTimeout(`[${this.channelId}] session reload`, SESSION_RELOAD_TIMEOUT_MS, () =>
				this.session.reload(),
			);
		} catch (error) {
			log.logWarn("agent.session.reload_unsettled", "Session reload did not settle", {
				channelId: this.channelId,
				reason: errorMessage(error),
			});
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
					this.syncMemoryBootstrapPendingFromSession();
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await this.session.navigateTree(targetId, options);
					this.syncMemoryBootstrapPendingFromSession();
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					const result = await this.sessionRuntime.switchSession(sessionPath, options);
					this.syncMemoryBootstrapPendingFromSession();
					return result;
				},
				reload: async () => {
					await this.refreshSessionResources();
				},
			},
		});
	}

	async ensureSessionReady(): Promise<void> {
		await this.sessionReady;
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
			log.logWarn(
				"agent.models.refresh_unsettled",
				"Model registry refresh did not settle; using the previous snapshot",
				{ channelId: this.channelId, reason: errorMessage(error) },
			);
		}
		const discovery = discoverSubAgents(this.workspaceDir, this.modelRegistry.getAvailable());
		for (const warning of discovery.warnings) {
			log.logWarn("config.subagents.warning", "Sub-agent config warning", {
				channelId: this.channelId,
				reason: warning,
			});
		}
		return discovery;
	}

	private reportSettingsDiagnostics(): void {
		reportSettingsDiagnostics(this.settingsManager, this.channelId, this.appHomeDir);
	}

	private reportConfigDiagnostics(diagnostics: ConfigDiagnostic[]): void {
		for (const diagnostic of diagnostics) {
			log.logWarn("config.diagnostic", formatConfigDiagnostic(diagnostic), {
				channelId: this.channelId,
				fields: { path: diagnostic.path },
			});
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
	buildSystemPrompt(): PromptBuildResult {
		const toolNames = this.currentTools.map((tool) => tool.name);
		const resources = loadWorkspacePromptResources(this.workspaceDir);
		this.lastWorkspaceResources = resources;
		const build = buildPipiclawSystemPrompt({
			tools: this.currentTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
			})),
			soul: resources.soul,
			agents: resources.agents,
			playbooks: loadPlaybooks(toolNames),
			subAgents: this.subAgentDiscovery.agents.map((agent) => ({
				name: agent.name,
				description: agent.description,
				runtime: agent.runtime,
				harness: agent.harness,
				workload: agent.workload ?? (agent.runtime === "external" ? "heavy" : "light"),
				mutates: agent.mutates,
				unavailable: agent.unavailable,
			})),
		});

		for (const diagnostic of [...resources.diagnostics, ...build.diagnostics]) {
			if (diagnostic.level === "info") continue;
			log.logWarn("agent.prompt.diagnostic", "Prompt section diagnostic", {
				channelId: this.channelId,
				reason: diagnostic.message,
				fields: { level: diagnostic.level, section: diagnostic.sectionId },
			});
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
			cwd: this.cwd,
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
					getCurrentModel: () => this.session.model ?? this.models.activeModel,
					getAvailableModels: async () => {
						await this.modelRegistry.refresh();
						return this.modelRegistry.getAvailable();
					},
					getSessionStats: () => this.session.getSessionStats(),
					getThinkingLevel: () => this.session.thinkingLevel,
					getAvailableThinkingLevels: () => this.session.getAvailableThinkingLevels(),
					setThinkingLevel: (level) => this.models.setThinkingLevelCompat(level),
					cycleThinkingLevel: () => this.models.cycleThinkingLevelCompat(),
					getLastResponseModel: () => getLastAssistantUsage(this.session.messages)?.responseModel,
					switchModel: async (model) => {
						await this.models.setModelWithThinkingPreservation(model);
						this.models.activeModel = model;
						// Manual /model switch redefines the preferred model and clears fallback state.
						this.models.clearFallbackState();
					},
					refreshSessionResources: async () => {
						await this.refreshSessionResources();
					},
					runMemoryCommand: async (args) =>
						handleMemoryCommand({
							channelId: this.channelId,
							dotDir: this.dotDir,
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
					log.logWarn("agent.skills.diagnostic", "Skill diagnostic", {
						channelId: this.channelId,
						reason: diagnostic.message,
						fields: { type: diagnostic.type, path: diagnostic.path },
					});
				}
				return merged;
			},
		});
	}

	private createAgentSessionServices(resourceLoader: ResourceLoader): AgentSessionServices {
		return {
			cwd: this.cwd,
			agentDir: this.appHomeDir,
			settingsManager: asSdkSettingsManager(this.settingsManager),
			modelRuntime: this.modelRuntime,
			resourceLoader,
			diagnostics: [],
		};
	}

	/**
	 * Load a freshly constructed ResourceLoader before an `AgentSession` is built on top of it.
	 *
	 * `AgentSession` reads `resourceLoader.getExtensions()` in its constructor, and a loader that
	 * has never been loaded answers with an *empty* set. Skipping this leaves a replacement session
	 * with no extensions at all — no command extension (so `/model`, `/thinking`, `/session`,
	 * `/compact` and `/memory` fall through to the model as plain text), no memory lifecycle, no
	 * prompt-boundary footer, and no prompt templates. Tolerated on failure the same way
	 * `reloadSessionResources` tolerates a stuck reload: a degraded session still answers chat.
	 */
	private async loadSessionResources(resourceLoader: ResourceLoader): Promise<void> {
		try {
			await withTimeout(`[${this.channelId}] session resource load`, SESSION_RELOAD_TIMEOUT_MS, () =>
				resourceLoader.reload(),
			);
		} catch (error) {
			log.logWarn("agent.session.resources_failed", "Session resources did not load", {
				channelId: this.channelId,
				reason: errorMessage(error),
			});
		}
	}

	/**
	 * Resolve the initial thinking level using the same precedence as pi's SDK:
	 * session history, configured default, then medium. The effective value is
	 * clamped to the selected model before the session starts.
	 */
	private initializeThinkingLevel(agent: Agent, model: Model<Api>, sessionManager: SessionManager): void {
		initializeThinkingLevelCompat(agent, model, sessionManager, this.settingsManager.getDefaultThinkingLevel());
	}

	private async createSessionRuntime(
		sessionManager: SessionManager,
		sessionStartEvent?: SessionStartEvent,
	): Promise<{ session: AgentSession; resourceLoader: ResourceLoader }> {
		const tools = this.buildRuntimeTools();
		const agent = new Agent({
			initialState: {
				systemPrompt: "",
				model: this.models.activeModel,
				thinkingLevel: DEFAULT_MAIN_THINKING_LEVEL,
				tools: [],
				messages: sessionManager.buildSessionContext().messages,
			},
			convertToLlm,
			getApiKey: async () => getApiKeyForModel(this.modelRegistry, this.models.activeModel),
			streamFn: streamSimple,
		});
		this.initializeThinkingLevel(agent, this.models.activeModel, sessionManager);
		const resourceLoader = this.createResourceLoader();
		// Must precede `new AgentSession`: the session snapshots the loader's extensions in its
		// constructor (see `loadSessionResources`).
		await this.loadSessionResources(resourceLoader);
		const sessionSettingsManager = asSdkSettingsManager(this.settingsManager);
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: sessionSettingsManager,
			cwd: this.cwd,
			modelRuntime: this.modelRuntime,
			resourceLoader,
			baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
			initialActiveToolNames: tools.map((tool) => tool.name),
			sessionStartEvent,
		});
		this.sessionSettingsManager = sessionSettingsManager;
		return { session, resourceLoader };
	}

	/**
	 * Bind this runner to a task cycle's own session (spec 051, D3/INV-5).
	 *
	 * Task work must not accumulate in the channel's chat transcript: the one real channel on the
	 * author's machine had grown to 7.4 MB and been compacted six times because chat and two daily
	 * tasks shared it, so every compaction damaged all three at once. Swapping the bound session
	 * per turn gives each task its own bounded context while leaving turn state, `/stop`, and
	 * delivery exactly where they already are.
	 */
	async bindTaskSession(taskId: string): Promise<void> {
		await this.sessionReady;
		const path = taskSessionPath(this.dotDir, taskId);
		await mkdir(dirname(path), { recursive: true });
		this.taskLoop = { taskId };
		await this.sessionRuntime.switchSession(path);
		this.syncMemoryBootstrapPendingFromSession();
	}

	/** Return to the channel's chat session after a task step. Safe to call when already bound. */
	async bindChatSession(): Promise<void> {
		if (!this.taskLoop) return;
		this.taskLoop = undefined;
		await this.sessionRuntime.switchSession(join(this.dotDir, resolveActiveSessionFile(this.dotDir)));
		this.syncMemoryBootstrapPendingFromSession();
	}

	/** Bootstrap presence follows canonical context, including omissions and compaction.
	 * Returning from a task or restarting must neither duplicate a visible bootstrap nor
	 * mistake an omitted failed input for one. Raw messages remain available to memory/recovery.
	 */
	private syncMemoryBootstrapPendingFromSession(): void {
		const injected = this.sessionManager.buildSessionContext().messages.some((value) => {
			const message: unknown = value;
			if (!isRecord(message)) return false;
			return message.role === "user" && hasMemoryBootstrapBlock(plainTextOf(message.content));
		});
		this.firstTurnMemoryBootstrapPending = !injected;
	}

	/** Which task loop this runner is currently bound to, if any. */
	getTaskLoop(): { taskId: string } | undefined {
		return this.taskLoop;
	}

	private buildRuntimeTools(): AgentTool<any>[] {
		const securityLoad = this.loadSecurityConfig();
		const toolsLoad = loadToolsConfigWithDiagnostics(this.appHomeDir);
		this.reportConfigDiagnostics([...securityLoad.diagnostics, ...toolsLoad.diagnostics]);
		this.tasksEnabled = toolsLoad.config.tools.tasks.enabled;

		const tools = createPipiclawTools({
			jobManager: this.jobManager,
			runManager: this.runManager,
			executor: this.executor,
			fileStore: this.fileStore,
			getCurrentModel: () => this.models.activeModel,
			getAvailableModels: () => this.modelRegistry.getAvailable(),
			resolveApiKey: async (model) => getApiKeyForModel(this.modelRegistry, model),
			workspaceDir: this.workspaceDir,
			cwd: this.cwd,
			dotDir: this.dotDir,
			channelId: this.channelId,
			getSubAgentDiscovery: () => this.subAgentDiscovery,
			getSubAgentModelReference: () => this.settingsManager.getSubAgentModelReference(),
			resolveFallbackModel: () => this.models.resolveFallbackModel(),
			getSessionSearchSettings: () => this.settingsManager.getSessionSearchSettings(),
			securityConfig: securityLoad.config,
			toolsConfig: toolsLoad.config,
			mediaSender: this.mediaSender,
			taskLoop: this.taskLoop,
			getToolsUsed: () => this.runState.toolsUsed,
			// Assistant usage only: an internal sub-agent's cost is also in `totalUsage`, and a bound
			// one is already credited to the task when it settles.
			getStepCost: () => ({ usd: this.runState.assistantUsage.cost.total, estimated: !this.runState.costKnown }),
		});
		this.currentTools = tools;
		// Tool schemas are billed with the system prompt and, unlike it, nothing trims them.
		// Warn where the prompt's own budget diagnostics are reported, once per tool rebuild.
		const schemas = measureToolSchemas(tools);
		if (schemas.units > TOOL_SCHEMA_TARGET_UNITS) {
			log.logWarn("agent.tools.schema_over_budget", "Tool schemas over budget", {
				channelId: this.channelId,
				reason: toolSchemaBudgetWarning(schemas),
			});
		}
		return tools;
	}

	private rebuildSessionTools(): void {
		const tools = this.buildRuntimeTools();
		setSessionBaseToolsOverride(this.session, tools, this.channelId);
		this.agent.state.tools = tools;
		this.session.setActiveToolsByName(tools.map((tool) => tool.name));
	}

	// === Session event subscription ===

	private subscribeToSessionEvents(): void {
		this.sessionUnsubscribe?.();
		this.sessionUnsubscribe = this.session.subscribe((event: unknown) => {
			// Observation is deliberately before our consumer and must never alter a turn.
			try {
				this.onSessionEvent?.(event, this.channelId);
			} catch (err) {
				log.logWarn("agent.session.observer_failed", "Session observer failed", {
					channelId: this.channelId,
					reason: errorMessage(err),
				});
			}
			if (isRecord(event) && event.type === "message_start") {
				this.deps.markStreaming();
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
				log.logWarn("agent.session.handler_failed", "Session event handler failed", {
					channelId: this.channelId,
					reason: errorMessage(err),
				});
			});
		});
	}
}
