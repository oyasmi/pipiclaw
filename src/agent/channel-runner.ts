/**
 * The per-channel agent runner: the public API the transports drive (turn lifecycle, steering, status,
 * retire/dispose), delegating the SDK session to `session/session-host.ts` and the steps of a turn to
 * `turn/`. Owns the turn state machine.
 */
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir } from "fs/promises";
import { join } from "path";
import { resolveActiveSessionFile } from "../channel/active-session-store.js";
import type { ChannelContext, MediaSender } from "../channel/channel-context.js";
import type { InboundImage } from "../channel/channel-event.js";
import type { ChannelStore } from "../channel/store.js";
import { isKnownCommandName, type RunnerBuiltInCommand, slashCommandName } from "../commands/catalog.js";
import type { PipiclawSettingsManager } from "../config/settings.js";
import type { DeskConversation } from "../desk/types.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import type { DeskJobManager } from "../jobs/manager.js";
import * as log from "../log.js";
import { MemoryLifecycle } from "../memory/lifecycle.js";
import {
	createMemoryActivityRecorder,
	type MemoryActivityEvent,
	type MemoryActivityRecorder,
} from "../memory/maintenance-state.js";
import { getMemoryMaintenanceTuning } from "../memory/maintenance-tuning.js";
import type { MemoryMaintenanceRuntimeContext } from "../memory/scheduler.js";
import { getApiKeyForModel } from "../models/api-keys.js";
import { runPromptWithFallback } from "../models/fallback.js";
import { formatModelReference } from "../models/reference.js";
import { defaultModel } from "../models/runtime.js";
import type { LoadedSecurityConfig } from "../security/config.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { loadPipiclawSkills } from "../skills/loader.js";
import type { SubAgentDiscoveryResult } from "../subagents/discovery.js";
import type { SubAgentRunManager } from "../subagents/runs.js";
import { getUsageLedger } from "../usage/ledger.js";
import type { UsageTotals } from "../usage/totals.js";
import { handleBuiltinCommand, requireQueuedMessage } from "./builtin-commands.js";
import { measureToolSchemas, type PromptTurnContextStats, renderContextReport } from "./prompt/manifest.js";
import { ModelSelection } from "./session/model-selection.js";
import { SessionHost } from "./session/session-host.js";
import { reportSettingsDiagnostics } from "./session/settings-diagnostics.js";
import { createRunQueue } from "./turn/run-queue.js";
import { TurnFinisher } from "./turn/turn-finish.js";
import { createTurnProgress, TurnPipeline } from "./turn/turn-pipeline.js";
import { assembleTurnPrompt } from "./turn/turn-prompt.js";
import { recoverInterruptedTurn } from "./turn/turn-recovery.js";
import { TurnStateMachine } from "./turn/turn-state.js";
import type { RunnerDeps, RunnerFactoryPaths } from "./types.js";
import {
	type AgentRunner,
	createEmptyRunState,
	type RunnerStatusSnapshot,
	type RunState,
	type TurnStatus,
} from "./types.js";

export class ChannelRunner implements AgentRunner {
	// --- Constructed once ---
	private readonly executor: Executor;
	private readonly jobManager: DeskJobManager;
	private readonly runManager: SubAgentRunManager;
	private readonly fileStore: FileStore;
	readonly conversation: DeskConversation;
	private readonly channelId: string;
	/** This channel's conversation directory inside the desk: sessions, active pointer, archive. */
	private readonly conversationDir: string;
	private readonly appHomeDir: string;
	private readonly authConfigPath: string;
	private readonly modelsConfigPath: string;
	private readonly onSessionEvent?: (event: unknown, channelId: string) => void;
	private readonly mediaSender?: MediaSender;
	private readonly workspaceDir: string;
	/** Re-read per use, not captured once: an edited security.json takes effect without a restart. */
	private readonly loadSecurityConfig: () => LoadedSecurityConfig;
	private readonly settingsManager: PipiclawSettingsManager;
	private readonly host: SessionHost;
	private readonly turnFinisher: TurnFinisher;
	private readonly pipeline: TurnPipeline;
	private readonly memoryLifecycle: MemoryLifecycle;
	private readonly ledger = getUsageLedger();
	private readonly memoryActivityRecorder: MemoryActivityRecorder;
	// --- Mutable across runs ---
	private readonly models: ModelSelection;
	private lastTurnContextStats?: PromptTurnContextStats;
	/** Single owner of turn state; see TurnPhase in types.ts and TurnStateMachine in turn-state.ts. */
	private readonly turnState = new TurnStateMachine((message, detail) =>
		log.logWarn("agent.session.warning", message, { channelId: this.channelId, reason: detail }),
	);
	/** Set once transport-level `/new` replaces this generation. A retired runner is never reused. */
	private retired = false;

	// --- Per run ---
	private runState: RunState = createEmptyRunState();

	constructor(conversation: DeskConversation, paths: RunnerFactoryPaths, deps: RunnerDeps) {
		const { channelId, conversationDir } = conversation;
		this.conversation = conversation;
		this.channelId = channelId;
		this.conversationDir = conversationDir;
		this.appHomeDir = paths.appHomeDir;
		this.authConfigPath = paths.authConfigPath;
		this.modelsConfigPath = paths.modelsConfigPath;
		this.onSessionEvent = paths.onSessionEvent;
		this.mediaSender = paths.mediaSender;

		this.executor = deps.executor;
		this.jobManager = paths.jobManager;
		this.runManager = paths.runManager;
		this.fileStore = deps.fileStore;
		this.loadSecurityConfig = deps.loadSecurityConfig;
		this.workspaceDir = paths.workspaceDir;

		// Initial skill summaries
		const initialSkills = loadPipiclawSkills(this.workspaceDir);

		// Create session manager, opening whichever session this conversation's active-session ref
		// (or the context.jsonl default, for a conversation that has never run a topology op) names
		// (spec 043, D1). The cwd override is the desk's working directory: a session header written
		// before spec 058 still names the old project root.
		const activeSessionFile = resolveActiveSessionFile(conversationDir);
		const sessionManager = SessionManager.open(
			join(conversationDir, activeSessionFile),
			conversationDir,
			conversation.cwd,
		);

		// Per-runner recovery barrier (spec 043, D10 point 2): repairs must run against this exact
		// SessionManager instance, before anything else touches it — a second `open()` of the same
		// file would mutate a branch this instance never sees, silently desyncing the two. The
		// daemon's own startup scan (bootstrap.ts) covers channels with no live runner yet; this
		// covers lazy channels, the TUI, and a channel whose file was fixed by hand after the scan
		// already ran and reported it blocked.
		const recoveryOutcome = recoverInterruptedTurn(sessionManager, {
			api: defaultModel.api,
			provider: defaultModel.provider,
			model: defaultModel.id,
		});
		if (recoveryOutcome.kind === "blocked") {
			throw new Error(
				`[${channelId}] Cannot start channel: session left in an unrecoverable state after a restart (${recoveryOutcome.reason}). ` +
					`Back up ${join(conversationDir, activeSessionFile)} on the host, move it aside, then use /new to start a fresh session.`,
			);
		}
		if (recoveryOutcome.kind === "repaired") {
			log.logWarn("agent.turn.repaired", "Interrupted turn repaired on restart", {
				channelId: channelId,
				fields: {
					toolResults: recoveryOutcome.appendedToolResults,
					abortedAssistant: recoveryOutcome.appendedAbortedAssistant,
				},
			});
		}
		this.settingsManager = paths.settingsManager;
		reportSettingsDiagnostics(this.settingsManager, this.channelId, this.appHomeDir);
		this.memoryActivityRecorder = createMemoryActivityRecorder({
			appHomeDir: this.appHomeDir,
			onError: (ref, error) =>
				log.logWarn("memory.state.record_failed", "Memory maintenance state record failed", {
					channelId: ref.channelId,
					reason: errorMessage(error),
				}),
		});

		this.models = new ModelSelection({
			channelId: this.channelId,
			settingsManager: this.settingsManager,
			getSession: () => this.session,
			getSessionSettingsManager: () => this.host.sessionSettingsManager,
			getModelRegistry: () => this.host.modelRegistry,
		});

		this.memoryLifecycle = new MemoryLifecycle({
			conversation,
			workspaceDir: this.workspaceDir,
			appHomeDir: this.appHomeDir,
			getMessages: () => this.session.messages,
			getSessionEntries: () => this.sessionManager.getBranch(),
			getModel: () => this.session.model ?? this.models.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.host.modelRegistry, model),
			recordMemoryActivity: (event) => this.recordMemoryActivity(event),
		});

		this.host = new SessionHost({
			conversation,
			workspaceDir: this.workspaceDir,
			appHomeDir: this.appHomeDir,
			authConfigPath: this.authConfigPath,
			modelsConfigPath: this.modelsConfigPath,
			onSessionEvent: this.onSessionEvent,
			mediaSender: this.mediaSender,
			// The working directory: the desk directory unless `desk.json` sets `cwd` (spec 058, D9).
			cwd: conversation.cwd,
			describeConversation: paths.describeConversation,
			settingsManager: this.settingsManager,
			loadSecurityConfig: this.loadSecurityConfig,
			executor: this.executor,
			fileStore: this.fileStore,
			jobManager: this.jobManager,
			runManager: this.runManager,
			memoryLifecycle: this.memoryLifecycle,
			models: this.models,
			ledger: this.ledger,
			initialSkills,
			getRunState: () => this.runState,
			markStreaming: () => this.turnState.markStreaming(),
		});
		this.pipeline = new TurnPipeline({
			conversation,
			workspaceDir: this.workspaceDir,
			describeChannel: paths.describeChannel,
			host: this.host,
			models: this.models,
			turnState: this.turnState,
			isRetired: () => this.retired,
			getRunState: () => this.runState,
		});
		this.turnFinisher = new TurnFinisher({
			conversation,
			host: this.host,
			models: this.models,
			ledger: this.ledger,
			turnState: this.turnState,
			getRunState: () => this.runState,
			flushMemoryActivity: () => this.flushMemoryActivity(),
			endTurn: () => this.endTurn(),
		});
		this.host.start(sessionManager);
		void this.host.sessionReady
			.then(() => this.memoryLifecycle.resumeBoundaryReflect())
			.catch((error: unknown) => {
				log.logWarn("memory.boundary.resume_failed", "Boundary memory resume failed", {
					channelId,
					reason: errorMessage(error),
				});
			});
	}

	private get session(): AgentSession {
		return this.host.session;
	}

	private get sessionManager(): SessionManager {
		return this.host.sessionManager;
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
		this.host.compaction.cancel("stop");
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
		const turn = createTurnProgress();

		try {
			await this.host.ensureSessionReady();
			this.host.assertContextHealthy();
			await this.models.maybeRestorePrimaryModel();
			this.memoryLifecycle.noteUserTurnStarted();
			const input = await this.pipeline.prepareUserInput(ctx);

			// Ensure the conversation directory (and with it the desk directory) exists.
			await mkdir(this.conversationDir, { recursive: true });

			const channelCapsule = await this.pipeline.gatherTurnContext(input.preserveRawInput, turn);
			const assembled = assembleTurnPrompt({
				clippedInput: input.clippedInput,
				userMessage: input.userMessage,
				preserveRawInput: input.preserveRawInput,
				channelCapsule,
				durableMemoryBootstrap: turn.durableMemoryBootstrapText,
				taskDigest: turn.taskDigestText,
			});
			turn.promptText = assembled.text;

			// Resolved before the compaction estimate below (which needs the image count) and
			// refreshed inside `setModel` further down if a fallback switches models mid-turn
			// (spec 049 D7) — a model's image support is looked up here explicitly because the
			// SDK's own handling of an unsupported model is to silently replace each image block
			// with a text placeholder.
			turn.images = await this.pipeline.prepareTurnImages(ctx);

			// Estimated against the fully assembled prompt (recall + task digest + bootstrap all
			// included above), not just the bare user message — those pieces can add thousands of
			// characters and must count against the projected context usage this guard is checking.
			// Each image adds a fixed per-image estimate on top of the text: three attached photos
			// can by themselves push a turn over the threshold that would trigger this guard.
			await this.pipeline.maybeRunPreventiveCompactionForIncomingText(turn.promptText, turn.images.images.length);

			this.lastTurnContextStats = assembled.stats;

			turn.fallbackAttempted = await runPromptWithFallback(
				turn.promptText,
				this.pipeline.buildFallbackDeps(ctx, runQueue, turn, ownTurn),
			);
		} catch (err) {
			this.runState.stopReason = "error";
			this.runState.errorMessage = errorMessage(err);
			log.logEvent("error", "agent.turn.failed", "Runner failed", {
				ctx: this.runState.logCtx ?? { channelId: this.channelId },
				fields: { error: this.runState.errorMessage },
			});
		} finally {
			await this.turnFinisher.finish({
				ctx,
				ownTurn,
				implicitTurn,
				promptSubmitted: turn.promptSubmitted,
				runQueue,
				fallbackAttempted: turn.fallbackAttempted,
				fallbackTargetRef: turn.fallbackTargetRef,
				promptText: turn.promptText,
				durableMemoryBootstrapText: turn.durableMemoryBootstrapText,
				taskDigestText: turn.taskDigestText,
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

	async handleBuiltinCommand(ctx: ChannelContext, command: RunnerBuiltInCommand): Promise<void> {
		await handleBuiltinCommand(
			{
				channelId: this.channelId,
				ensureSessionReady: () => this.host.ensureSessionReady(),
				promptTemplates: () => this.session.promptTemplates,
				renderContextReport: (args) => this.renderContextReport(args),
			},
			ctx,
			command,
		);
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
				this.host.currentSkills.skills.map((skill) => skill.name.toLowerCase()),
			)
		) {
			return true;
		}
		// Synchronous dispatch-path call: before the session runtime finishes building,
		// fall back to the static catalog + skills only. Misclassifying a prompt template
		// as "unknown" for the first few hundred ms after a runner is created is far
		// cheaper than throwing on the dispatch main path (spec 048 F2/D7).
		if (!this.host.sessionInitialized) {
			return false;
		}
		return this.session.promptTemplates.some((template) => template.name.toLowerCase() === name);
	}

	async queueSteer(text: string, userName?: string, images?: InboundImage[]): Promise<void> {
		await this.pipeline.queueBusyMessage(requireQueuedMessage(text, "steer"), userName, images);
	}

	async flushMemoryForShutdown(): Promise<void> {
		this.host.compaction.cancel("shutdown");
		await this.host.ensureSessionReady();
		await this.flushMemoryActivity();
		await this.memoryLifecycle.flushForShutdown();
	}

	async dispose(): Promise<void> {
		await this.flushMemoryForShutdown();
		if (this.isBusy()) {
			// `session.dispose()` aborts in-flight work; a busy runner keeps its session and
			// subscription until whoever holds it calls dispose() again once idle.
			log.logWarn("agent.session.dispose_skipped", "Dispose skipped while busy; session left intact", {
				channelId: this.channelId,
			});
			return;
		}
		await this.host.disposeSession();
	}

	async getMemoryMaintenanceContext(): Promise<MemoryMaintenanceRuntimeContext> {
		await this.host.ensureSessionReady();
		this.settingsManager.reload();
		return {
			conversation: this.conversation,
			workspaceDir: this.workspaceDir,
			// Snapshot only when a maintenance job actually needs the transcript; most ticks
			// stop at a schedule gate and never call these.
			messages: () => [...this.session.messages],
			sessionEntries: () => [...this.sessionManager.getBranch()],
			model: this.session.model ?? this.models.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.host.modelRegistry, model),
			settings: { memoryMaintenance: this.settingsManager.getMemoryMaintenanceSettings() },
		};
	}

	getStatusSnapshot(): RunnerStatusSnapshot {
		const model = this.session.model ?? this.models.activeModel;
		const contextTokens = this.session.getContextUsage()?.tokens;
		return {
			model: formatModelReference(model),
			contextTokens: typeof contextTokens === "number" ? contextTokens : undefined,
			contextWindow: model.contextWindow || 200000,
			thinkingLevel: this.session.thinkingLevel,
			fallback: this.models.fallbackStatus(model),
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
		if (!this.retired && this.session) this.memoryLifecycle.noteNewSessionBoundary();
		this.retireForRecovery();
	}

	retireForRecovery(): void {
		if (this.retired) return;
		this.retired = true;
		this.requestStop();
		// close() marks the delivery context closed synchronously before awaiting its drain,
		// so late events from the old provider cannot overwrite the new session's response.
		void this.runState.ctx?.close().catch(() => undefined);
		this.forceEndTurn("runner generation retired");

		this.host.retireLiveSession();
	}

	/**
	 * `/context` — read-only prompt accounting, no LLM cost. Reports the section
	 * breakdown of the system prompt, the tool schemas (billed on top of it, and
	 * often the larger half), and the last turn's dynamic context.
	 */
	renderContextReport(args = ""): string {
		const build = this.host.lastPromptBuild ?? this.host.buildSystemPrompt();
		return renderContextReport({
			build,
			skills: this.host.currentSkills.skills.map((skill) => ({ name: skill.name, description: skill.description })),
			finalPrompt: this.host.lastFinalPrompt,
			toolNames: this.host.currentTools.map((tool) => tool.name),
			toolSchemas: measureToolSchemas(this.host.currentTools),
			soul: this.host.lastWorkspaceResources?.soul,
			agents: this.host.lastWorkspaceResources?.agents,
			lastTurn: this.lastTurnContextStats,
			detail: args.trim().toLowerCase() === "detail",
		});
	}

	/** `/subagents list`'s role-directory health tail — whatever this runner already discovered. */
	getSubAgentDiscoverySnapshot(): SubAgentDiscoveryResult {
		return this.host.subAgentDiscovery;
	}

	/**
	 * Bind this runner to a task cycle's own session (spec 051, D3/INV-5): task work must not
	 * accumulate in the channel's chat transcript, so each task turn runs in its own bounded session
	 * while turn state, `/stop` and delivery stay exactly where they already are.
	 */
	bindTaskSession(taskId: string): Promise<void> {
		return this.retired ? Promise.resolve() : this.host.bindTaskSession(taskId);
	}

	/** Return to the channel's chat session after a task step. Safe to call when already bound. */
	bindChatSession(): Promise<void> {
		return this.retired ? Promise.resolve() : this.host.bindChatSession();
	}

	/** Which task loop this runner is currently bound to, if any. */
	getTaskLoop(): { taskId: string } | undefined {
		return this.host.taskLoop;
	}

	// === Private helpers ===

	/**
	 * Buffer one activity event. The write itself is batched by the recorder (see
	 * `createMemoryActivityRecorder`); `run()` flushes at the end of every turn, which is the
	 * point the maintenance gates actually start looking at this state.
	 */
	private recordMemoryActivity(event: MemoryActivityEvent): void {
		const eventTime = parseLocalTime(event.timestamp);
		const eligibleAfter =
			eventTime !== undefined
				? formatLocalTime(
						new Date(eventTime + Math.max(0, getMemoryMaintenanceTuning().minIdleMinutesBeforeLlmWork) * 60_000),
					)
				: undefined;
		this.memoryActivityRecorder.record({ ...event, eligibleAfter });
	}

	/** Best-effort: a lost activity counter delays maintenance, it never breaks a turn. */
	private async flushMemoryActivity(): Promise<void> {
		try {
			await this.memoryActivityRecorder.flush(this.conversation);
		} catch (error) {
			log.logWarn("memory.state.flush_failed", "Memory maintenance state flush failed", {
				channelId: this.channelId,
				reason: errorMessage(error),
			});
		}
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
}
