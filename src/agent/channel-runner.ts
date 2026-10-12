import type { Agent } from "@earendil-works/pi-agent-core";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { resolveActiveSessionFile } from "../channel/active-session-store.js";
import type { ChannelContext, MediaSender } from "../channel/channel-context.js";
import type { InboundImage } from "../channel/channel-event.js";
import { resolveProjectScope } from "../channel/project-scope-store.js";
import type { ChannelStore } from "../channel/store.js";
import { isKnownCommandName, type RunnerBuiltInCommand, slashCommandName } from "../commands/catalog.js";
import type { PipiclawSettingsManager } from "../config/settings.js";
import type { Executor } from "../executor.js";
import type { FileStore } from "../file-store.js";
import type { ChannelJobManager } from "../jobs/manager.js";
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
import { type FallbackRunDeps, runPromptWithFallback } from "../models/fallback.js";
import { formatModelReference } from "../models/reference.js";
import { defaultModel } from "../models/runtime.js";
import type { LoadedSecurityConfig } from "../security/config.js";
import type { ProjectScope } from "../security/project-scope.js";
import { resolveProjectAccessPolicy } from "../security/project-scope.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { loadPipiclawSkills } from "../skills/loader.js";
import type { SubAgentDiscoveryResult } from "../subagents/discovery.js";
import type { SubAgentRunManager } from "../subagents/runs.js";
import { getUsageLedger } from "../usage/ledger.js";
import type { UsageTotals } from "../usage/totals.js";
import { handleBuiltinCommand, requireQueuedMessage } from "./builtin-commands.js";
import {
	buildPromptManifest,
	measureToolSchemas,
	type PromptTurnContextStats,
	renderContextReport,
} from "./prompt/manifest.js";
import { getLastAssistantUsage } from "./session/event-guards.js";
import { ModelSelection } from "./session/model-selection.js";
import { reportSettingsDiagnostics, SessionHost } from "./session/session-host.js";
import { estimateIncomingMessageTokens, getPreventiveCompactionDecision } from "./turn/context-budget.js";
import { clipUserInput, formatProgressEntry } from "./turn/progress-formatter.js";
import { createRunQueue } from "./turn/run-queue.js";
import {
	buildFirstTurnMemoryBootstrap,
	buildTaskDigestForTurn,
	renderChannelTurnContext,
} from "./turn/turn-context.js";
import { renderFallbackSwitch, renderTurnErrorReply } from "./turn/turn-error.js";
import {
	formatUserMessage,
	persistOversizedInput,
	prepareInboundImages,
	shouldPreserveRawInput,
} from "./turn/turn-input.js";
import { assembleTurnPrompt } from "./turn/turn-prompt.js";
import { recoverInterruptedTurn } from "./turn/turn-recovery.js";
import { type TurnHandle, TurnStateMachine } from "./turn/turn-state.js";
import type { RunnerDeps, RunnerFactoryPaths } from "./types.js";
import {
	type AgentRunner,
	createEmptyRunState,
	type FinalOutcome,
	MAX_USER_MESSAGE_CHARS,
	type RunnerStatusSnapshot,
	type RunState,
	type TurnStatus,
} from "./types.js";

function isSilentOutcome(outcome: FinalOutcome): outcome is { kind: "silent" } {
	return outcome.kind === "silent";
}

function isFinalOutcome(outcome: FinalOutcome): outcome is { kind: "final"; text: string } {
	return outcome.kind === "final";
}

function getFinalOutcomeText(outcome: FinalOutcome): string | null {
	return isFinalOutcome(outcome) ? outcome.text : null;
}

export class ChannelRunner implements AgentRunner {
	// --- Constructed once ---
	private readonly executor: Executor;
	private readonly jobManager: ChannelJobManager;
	private readonly runManager: SubAgentRunManager;
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
	private readonly settingsManager: PipiclawSettingsManager;
	private readonly host: SessionHost;
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

	constructor(channelId: string, channelDir: string, paths: RunnerFactoryPaths, deps: RunnerDeps) {
		this.channelId = channelId;
		this.channelDir = channelDir;
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

		// Create session manager, opening whichever session this channel's active-session ref
		// (or the context.jsonl default, for a channel that has never run a topology op) names
		// (spec 043, D1).
		const activeSessionFile = resolveActiveSessionFile(channelDir);
		const sessionManager = SessionManager.open(join(channelDir, activeSessionFile), channelDir);

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
					`Back up ${join(channelDir, activeSessionFile)} on the host, move it aside, then use /new to start a fresh session.`,
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
			onError: (channelId, error) =>
				log.logWarn("memory.state.record_failed", "Memory maintenance state record failed", {
					channelId: channelId,
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
			channelId: this.channelId,
			channelDir: this.channelDir,
			workspaceDir: this.workspaceDir,
			appHomeDir: this.appHomeDir,
			getMessages: () => this.session.messages,
			getSessionEntries: () => this.sessionManager.getBranch(),
			getModel: () => this.session.model ?? this.models.activeModel,
			resolveApiKey: async (model) => getApiKeyForModel(this.host.modelRegistry, model),
			recordMemoryActivity: (event) => this.recordMemoryActivity(event),
		});

		this.host = new SessionHost({
			channelId,
			channelDir,
			workspaceDir: this.workspaceDir,
			appHomeDir: this.appHomeDir,
			authConfigPath: this.authConfigPath,
			modelsConfigPath: this.modelsConfigPath,
			onSessionEvent: this.onSessionEvent,
			mediaSender: this.mediaSender,
			projectScope: this.projectScope,
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
		this.host.start(sessionManager);
	}

	private get session(): AgentSession {
		return this.host.session;
	}

	private get agent(): Agent {
		return this.host.agent;
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
			await this.host.ensureSessionReady();
			await this.models.maybeRestorePrimaryModel();
			this.memoryLifecycle.noteUserTurnStarted();
			const normalizedInputLength = ctx.message.text.replace(/\r/g, "").trim().length;
			let oversizedInputPath: string | undefined;
			if (normalizedInputLength > MAX_USER_MESSAGE_CHARS) {
				oversizedInputPath = await persistOversizedInput(this.channelDir, this.channelId, ctx.message.text);
				await ctx.respondInThread(
					oversizedInputPath
						? `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理；完整内容已存到 \`${oversizedInputPath}\`，需要时让我读取这个文件查看被省略的部分。`
						: `⚠️ 消息过长（${normalizedInputLength} 字符），已截断至约 ${MAX_USER_MESSAGE_CHARS} 字符后处理。`,
				);
			}
			const clippedInput = clipUserInput(ctx.message.text, MAX_USER_MESSAGE_CHARS, oversizedInputPath);
			const userMessage = formatUserMessage(clippedInput, ctx.message.userName);
			const preserveRawInput = shouldPreserveRawInput(ctx.message.text);

			// Ensure channel directory exists
			await mkdir(this.channelDir, { recursive: true });

			if (!preserveRawInput) {
				// Channel facts are turn-dynamic by design (spec 025 §7.3): keeping them out of the
				// system prompt is what lets every channel in a workspace share one cached prefix.
				channelCapsuleText = renderChannelTurnContext(this.channelDir);

				// The task digest reads the whole tasks/ directory and depends on nothing the memory
				// bootstrap below produces, so it runs alongside it rather than queuing behind it.
				// Settled into a result object rather than left as a bare promise: if the bootstrap
				// throws first we would otherwise leave a rejection unobserved, which Node's default
				// policy turns into a process exit. Rethrown at the await, so a digest failure still
				// fails the turn exactly as it did when this ran inline. A task step gets none: its brief
				// already carries its own task, and the channel's other tasks are noise there.
				const taskDigestPromise = (
					this.host.tasksEnabled && !this.host.taskLoop
						? buildTaskDigestForTurn(this.channelDir)
						: Promise.resolve("")
				).then(
					(text) => ({ text }) as { text: string; error?: never },
					(error: unknown) => ({ error }) as { text?: never; error: unknown },
				);

				// Spec 050, D1: the memory index is injected in full on the first turn of a session
				// (and the first turn after compaction — see `subscribeToSessionEvents`), never per
				// turn. Mid-session, the model uses `memory_search` to look things up.
				if (this.host.firstTurnMemoryBootstrapPending) {
					durableMemoryBootstrapText = await buildFirstTurnMemoryBootstrap(this.channelDir, this.workspaceDir);
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
			let preparedImages = await prepareInboundImages(
				ctx.message.images,
				this.session.model ?? this.models.activeModel,
			);
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
						await this.host.runPrompt(async () => {
							await this.session.prompt(
								text,
								preparedImages.images.length > 0 ? { images: preparedImages.images } : undefined,
							);
							promptSubmitted = true;
							if (bootstrapPrepared) this.host.firstTurnMemoryBootstrapPending = false;
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
				getCurrentModelRef: () => formatModelReference(this.session.model ?? this.models.activeModel),
				resolveFallbackModel: () => this.models.resolveFallbackModel(),
				setModel: async (model) => {
					await this.models.setModelWithThinkingPreservation(model);
					// The fallback model's vision support can differ from the one this turn started
					// on; re-resolve against it rather than resend whatever was prepared for the
					// model that just failed.
					preparedImages = await prepareInboundImages(
						ctx.message.images,
						this.session.model ?? this.models.activeModel,
					);
					for (const notice of preparedImages.notices) {
						await ctx.respondInThread(notice);
					}
				},
				notifySwitch: (from, to, errorSummary) => {
					fallbackTargetRef = to;
					if (this.runState.logCtx) {
						log.logModelFallback(this.runState.logCtx, from, to, errorSummary);
					}
					const text = renderFallbackSwitch(from, to, errorSummary);
					if (ctx.progressStyle !== "none") {
						runQueue.queue.enqueue(
							() => ctx.respond(formatProgressEntry("error", text), false),
							"fallback switch",
						);
					} else {
						runQueue.queue.enqueue(() => ctx.respondInThread(`⚠️ ${text}`), "fallback switch");
					}
				},
				markPrimaryFailed: () => {
					this.models.markPrimaryFailed();
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
				systemPrompt: this.host.lastFinalPrompt ?? this.agent.state.systemPrompt,
				promptManifest: this.host.lastPromptBuild
					? buildPromptManifest(this.host.lastPromptBuild, this.host.lastFinalPrompt)
					: undefined,
				messages: this.session.messages,
				durableMemoryBootstrap: input.durableMemoryBootstrapText || undefined,
				taskDigest: input.taskDigestText || undefined,
				newUserMessage: input.promptText,
			};
			await writeFile(join(this.channelDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2)).catch(
				(error: unknown) =>
					log.logWarn("agent.debug.dump_failed", "last_prompt.json write failed", {
						channelId: this.channelId,
						reason: errorMessage(error),
					}),
			);
		}
		if (!promptSubmitted) {
			const discarded = this.session.clearQueue();
			const discardedCount = discarded.steering.length + discarded.followUp.length;
			if (discardedCount > 0) {
				log.logWarn("agent.turn.queue_discarded", "Queued busy messages discarded after run setup failed", {
					channelId: this.channelId,
					fields: { count: discardedCount },
				});
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
					const compactionError = this.runState.lastCompactionError;
					await ctx.replaceMessage(
						renderTurnErrorReply({
							errorMessage: this.runState.errorMessage,
							compactionError:
								compactionError && compactionError !== this.runState.errorMessage ? compactionError : undefined,
							fallbackRef: fallbackAttempted ? fallbackTargetRef : undefined,
						}),
					);
				} catch (err) {
					const errMsg = errorMessage(err);
					log.logWarn("delivery.error_reply.failed", "Error reply failed", {
						channelId: this.channelId,
						reason: errMsg,
					});
				}
			} else if (isSilentOutcome(finalOutcome)) {
				try {
					await ctx.deleteMessage();
					log.logInfo(`[${this.channelId}] Silent response ended progress delivery`);
				} catch (err) {
					const errMsg = errorMessage(err);
					log.logWarn("delivery.silent_cleanup.failed", "Silent-response cleanup failed", {
						channelId: this.channelId,
						reason: errMsg,
					});
				}
			} else if (this.runState.stopReason === "aborted" && !this.runState.finalResponseDelivered) {
				try {
					await ctx.deleteMessage();
					log.logInfo(`[${this.channelId}] Aborted response discarded active delivery state`);
				} catch (err) {
					const errMsg = errorMessage(err);
					log.logWarn("delivery.abort_cleanup.failed", "Aborted-response cleanup failed", {
						channelId: this.channelId,
						reason: errMsg,
					});
				}
			} else if (finalOutcomeText && !this.runState.finalResponseDelivered) {
				try {
					await ctx.replaceMessage(finalOutcomeText);
				} catch (err) {
					const errMsg = errorMessage(err);
					log.logWarn("delivery.final_reply.failed", "Final reply replacement failed", {
						channelId: this.channelId,
						reason: errMsg,
					});
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
			const currentRunModel = this.session.model ?? this.models.activeModel;
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
		await this.queueBusyMessage(requireQueuedMessage(text, "steer"), userName, images);
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
			channelId: this.channelId,
			channelDir: this.channelDir,
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
		if (this.retired) return;
		this.retired = true;
		if (this.session) {
			this.memoryLifecycle.noteNewSessionBoundary();
		}
		// close() marks the delivery context closed synchronously before awaiting its drain,
		// so late events from the old provider cannot overwrite the new session's response.
		void this.runState.ctx?.close().catch(() => undefined);
		this.forceEndTurn("superseded by /new");

		const retireLiveSession = (): void => this.host.retireLiveSession();
		if (this.session) {
			retireLiveSession();
		} else {
			// A second message can issue `/new` while this generation is still initializing.
			// Let construction settle in the background, then immediately tear it down.
			void this.host.sessionReady.then(retireLiveSession, () => undefined);
		}
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
		return this.host.bindTaskSession(taskId);
	}

	/** Return to the channel's chat session after a task step. Safe to call when already bound. */
	bindChatSession(): Promise<void> {
		return this.host.bindChatSession();
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
			await this.memoryActivityRecorder.flush(this.channelId);
		} catch (error) {
			log.logWarn("memory.state.flush_failed", "Memory maintenance state flush failed", {
				channelId: this.channelId,
				reason: errorMessage(error),
			});
		}
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

		await this.host.ensureSessionReady();

		const oversized = text.replace(/\r/g, "").trim().length > MAX_USER_MESSAGE_CHARS;
		const oversizedPath = oversized ? await persistOversizedInput(this.channelDir, this.channelId, text) : undefined;
		const clippedText = clipUserInput(text, MAX_USER_MESSAGE_CHARS, oversizedPath);
		if (oversized) {
			log.logWarn("agent.input.clipped", "Queued message clipped", {
				channelId: this.channelId,
				fields: { limitChars: MAX_USER_MESSAGE_CHARS },
			});
		}
		const queuedMessage = formatUserMessage(clippedText, userName);
		const preparedImages = await prepareInboundImages(images, this.session.model ?? this.models.activeModel);
		for (const notice of preparedImages.notices) {
			await this.runState.ctx?.respondInThread(notice);
		}
		await this.maybeRunPreventiveCompactionForIncomingText(queuedMessage, preparedImages.images.length);

		this.assertBusyWindowOpen();

		const queueMessage = async () => {
			this.assertBusyWindowOpen();
			await this.session.steer(queuedMessage, preparedImages.images.length > 0 ? preparedImages.images : undefined);
		};

		await this.host.runPrompt(queueMessage);
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

	private async maybeRunPreventiveCompactionForIncomingText(
		incomingText: string,
		imageCount: number = 0,
	): Promise<void> {
		const currentModel = this.session.model ?? this.models.activeModel;
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
			log.logWarn("agent.compaction.preventive_failed", "Preventive compaction failed", {
				channelId: this.channelId,
				reason: message,
			});
		}
	}
}
