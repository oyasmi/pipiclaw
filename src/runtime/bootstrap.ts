import { join } from "path";
import { channelEffectCount, noteTaskEffects, taskEffectCount } from "../agent/effect-ledger.js";
import { type AgentRunner, createRunner } from "../agent/index.js";
import { channelRunningJobLines, configureJobRuntime, restoreChannelJobs } from "../agent/job-manager.js";
import { loadDetachedMaintenanceContext } from "../agent/maintenance-context.js";
import { renderStatus } from "../agent/status-render.js";
import { scanWorkspaceForInterruptedTurns } from "../agent/turn-recovery.js";
import { createFreshActiveSession } from "../channel/active-session-store.js";
import type { ChannelEvent } from "../channel/channel-event.js";
import { type ChannelIndex, createChannelIndex } from "../channel/channel-index.js";
import { ensureChannelDir, getChannelDir } from "../channel/channel-paths.js";
import { resolveProjectScope } from "../channel/project-scope-store.js";
import { ChannelStore } from "../channel/store.js";
import {
	BUILT_IN_COMMANDS,
	formatUnknownCommandMessage,
	isRunnerBuiltInCommand,
	parseBuiltInCommand,
	type RuntimeCommandName,
	slashCommandName,
} from "../commands/catalog.js";
import { createExecutor, type Executor } from "../executor.js";
import * as log from "../log.js";
import { ensureChannelMemoryFilesSync } from "../memory/files.js";
import { MemoryMaintenanceScheduler } from "../memory/scheduler.js";
import { defaultModel } from "../models/utils.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { flushSecurityLogs } from "../security/logger.js";
import { resolveProjectAccessPolicy } from "../security/project-scope.js";
import { PipiclawSettingsManager } from "../settings.js";
import { formatConfigDiagnostic } from "../shared/config-diagnostic.js";
import { fileStamp } from "../shared/file-stamp.js";
import { errorMessage } from "../shared/text-utils.js";
import { loadDetachedSubAgentDiscovery } from "../subagents/detached-discovery.js";
import {
	configureSubAgentRuntime,
	getSubAgentRunManager,
	restoreAllSubAgentRuns,
	stopSubAgentGarbageCollector,
} from "../subagents/runs.js";
import { readActiveTasks } from "../tasks/ledger.js";
import type { WakeTaskTransitionHooks } from "../tasks/store.js";
import { getToolsConfigPath, loadToolsConfig, loadToolsConfigWithDiagnostics } from "../tools/config.js";
import { getUsageLedger } from "../usage/ledger.js";
import { parseUsageMode, renderUsageReport } from "../usage/render.js";
import {
	BootstrapExitError,
	type BootstrapIO,
	type BootstrapPaths,
	bootstrapAppHome,
	DEFAULT_BOOTSTRAP_PATHS,
	loadConfig,
	parseArgs,
	printBootstrapSummary,
	readCliVersion,
} from "./app-home.js";
import { createDingTalkContext } from "./delivery.js";
import {
	type BusyMessageMode,
	type BusyMessageResult,
	DingTalkBot,
	type DingTalkConfig,
	type DingTalkHandler,
	type StopOutcome,
} from "./dingtalk.js";
import { DurableDispatchService } from "./durable-dispatch.js";
import { handleEventsCommand as runEventsCommand } from "./event-commands.js";
import { createEventsWatcher } from "./events.js";
import { handleProjectCommand as runProjectCommand } from "./project-commands.js";
import { installLlmProxy } from "./proxy.js";
import { handleSkillsCommand as runSkillsCommand } from "./skill-commands.js";
import { renderRunNotice, handleSubagentsCommand as runSubagentsCommand } from "./subagent-commands.js";
import { pauseTask, handleTasksCommand as runTasksCommand } from "./task-commands.js";
import { createTaskDriverEvent, TaskDriver } from "./task-driver.js";
import { migrateLegacyTaskScheduleEvents, migrateLegacyTaskState } from "./task-migration.js";
import { claimVerifiedDelegationWake, claimVerifiedJobWake } from "./task-wake.js";

export interface BootstrapOptions {
	env?: NodeJS.ProcessEnv;
	io?: BootstrapIO;
	paths?: BootstrapPaths;
	registerSignalHandlers?: boolean;
	startServices?: boolean;
}

export interface AppContext {
	bot: DingTalkBot;
	store: ChannelStore;
	shutdown: () => Promise<void>;
}

const SHUTDOWN_WAIT_MS = 15000;
const SHUTDOWN_FLUSH_WAIT_MS = 45000;
const SHUTDOWN_ABORT_WAIT_MS = 5000;
const SHUTDOWN_LOG_FLUSH_WAIT_MS = 10_000;

export interface RuntimeContext {
	handler: DingTalkHandler;
	store: ChannelStore;
	/** Production driver instance, exposed so evals can invoke the real scan path. */
	taskDriver: { start(): void; stop(): void; nudge?(): void; runOnce?: (now?: Date) => Promise<void> };
	/**
	 * Production maintenance scheduler, exposed for the same reason as `taskDriver`.
	 *
	 * Evaluation workers run with `startServices: false`, so the background timer never fires and
	 * no trial could otherwise reach `SESSION.md` refresh, the memory checkpoint, or consolidation
	 * — the whole layered memory pipeline was structurally untestable from a behavior eval.
	 * Exposing the instance lets a case drive one real pass at a chosen time instead of faking a
	 * clock or re-implementing the job order.
	 */
	memoryMaintenance: { start(): void; stop(): void; runOnce?: (now?: Date) => Promise<void> };
	shutdown: (reason?: NodeJS.Signals | "manual") => Promise<void>;
}

function waitForTasks(tasks: Promise<void>[], timeoutMs: number): Promise<boolean> {
	if (tasks.length === 0) {
		return Promise.resolve(true);
	}

	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
		void Promise.allSettled(tasks).then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/**
 * Ceiling on cached runners per daemon process. A long-lived daemon otherwise accumulates one
 * `ChannelRunner` (session, subscriptions, memory state) per distinct channel it has ever heard
 * from, unbounded, for the life of the process. Eviction below only ever touches idle runners —
 * a busy one is left cached past the cap rather than mid-turn disposed.
 */
const MAX_CACHED_RUNNERS = 50;

/**
 * Drop the least-recently-used *idle* runners until the cache is back at the cap, disposing each
 * one (flush memory, unsubscribe, release the SDK session) before dropping it. `channelRunners`
 * is a `Map`, so insertion order is iteration order; `getRunner` below re-inserts on every cache
 * hit to keep that order equal to recency of use — the standard "LRU via Map" idiom.
 */
async function evictIdleRunnersOverCap(channelRunners: Map<string, AgentRunner>): Promise<void> {
	if (channelRunners.size <= MAX_CACHED_RUNNERS) return;
	for (const [channelId, runner] of channelRunners) {
		if (channelRunners.size <= MAX_CACHED_RUNNERS) break;
		if (runner.isBusy()) continue;
		channelRunners.delete(channelId);
		await runner.dispose().catch((err) => {
			log.logWarning(`[${channelId}] Failed to dispose evicted runner`, errorMessage(err));
		});
	}
}

function isNoRunningTaskQueueError(err: unknown): boolean {
	return err instanceof Error && err.message === "No task is currently running.";
}

/**
 * The `runRuntimeCommand` names usable on the idle-turn path — every `BUILT_IN_COMMANDS` entry
 * *not* marked `runnerHandled`, i.e. every stateless report. `context` is the one deliberate
 * exception even though it isn't runner-handled while busy (see the busy-path switch in
 * `dingtalk.ts`): idle answers it through the runner's ChannelContext-aware command path
 * (thread-reply, delete semantics) instead, so it is routed like the runner-handled built-ins
 * here and excluded from this stateless-report set.
 */
const IDLE_RUNTIME_COMMAND_NAMES = new Set<string>(
	BUILT_IN_COMMANDS.filter((command) => !command.runnerHandled).map((command) => command.name),
);

function isIdleRuntimeCommandName(name: string): name is Exclude<RuntimeCommandName, "context"> {
	return IDLE_RUNTIME_COMMAND_NAMES.has(name);
}

/**
 * How long `/stop` waits for the turn to actually end before force-releasing it.
 * `requestStop` + `abort` only reach the agent loop; a turn wedged in its
 * epilogue (delivery drain, session-resource reload, memory flush) ignores both
 * and would otherwise keep the channel reporting "已有回合在运行" indefinitely.
 */
const STOP_FORCE_END_GRACE_MS = 15_000;
const STOP_FORCE_END_POLL_MS = 250;

function sleepUnref(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * Watchdog for `/stop`: release the channel if the stopped turn has not ended
 * once the grace window elapses. Returns true when it had to force the release.
 */
export async function forceEndStuckTurnAfterStop(input: {
	channelId: string;
	runner: AgentRunner;
	graceMs?: number;
	pollMs?: number;
	notify?: (text: string) => Promise<unknown>;
}): Promise<boolean> {
	const graceMs = input.graceMs ?? STOP_FORCE_END_GRACE_MS;
	const pollMs = input.pollMs ?? STOP_FORCE_END_POLL_MS;
	const deadline = Date.now() + graceMs;
	while (input.runner.isBusy() && Date.now() < deadline) {
		await sleepUnref(Math.min(pollMs, Math.max(1, deadline - Date.now())));
	}
	if (!input.runner.forceEndTurn(`/stop did not take effect within ${graceMs}ms`)) {
		return false;
	}
	await input
		.notify?.(
			`⚠️ 上一个回合的收尾卡住了，已强制结束以释放会话（后台清理仍在继续）。现在可以正常发消息或使用 \`/new\`、\`/model\`。`,
		)
		.catch(() => undefined);
	return true;
}

interface RuntimeContextOptions {
	paths: BootstrapPaths;
	dingtalkConfig: DingTalkConfig;
	createBot?: (handler: DingTalkHandler, config: DingTalkConfig) => DingTalkBot;
	createEventsWatcher?: (
		workspaceDir: string,
		bot: DingTalkBot,
		executor: Executor,
		eventHistoryPath: string,
	) => { start(): void; stop(): void; flush?(): Promise<void> };
	createMemoryMaintenanceScheduler?: () => { start(): void; stop(): void };
	memoryMaintenanceSchedulerIntervalMs?: number;
	createTaskDriver?: () => { start(): void; stop(): void; nudge?(): void };
	/** Receives raw SDK session events after subscription, without changing runtime handling. */
	observer?: (event: unknown, channelId: string) => void;
	/** Receives TaskDriver dispatch outcomes; used only by isolated evaluation workers. */
	onTaskDriverDispatch?: (event: ChannelEvent, accepted: boolean) => void;
	startServices?: boolean;
	registerSignalHandlers?: boolean;
	/** Test-only fault seams for the atomic structured-wake task transition. */
	wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
	/** Override the `/stop` watchdog's grace window (tests use a short one). */
	stopForceEndGraceMs?: number;
	/**
	 * The app-level settings manager, shared by every channel's runner (see
	 * `agent/runner-factory.ts`'s `RunnerFactoryPaths.settingsManager`). `bootstrap()` passes the
	 * same instance `prepareAppServices()` already constructed and diagnosed; a caller that skips
	 * `prepareAppServices()` (tests) gets one built here instead.
	 */
	settingsManager?: PipiclawSettingsManager;
}

export async function createRuntimeContext(
	options: RuntimeContextOptions,
): Promise<RuntimeContext & { bot: DingTalkBot }> {
	const startServices = options.startServices ?? true;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const store = new ChannelStore({ workingDir: options.paths.workspaceDir });
	const runtimeSettingsManager = options.settingsManager ?? new PipiclawSettingsManager(options.paths.appHomeDir);
	log.configureLogging(runtimeSettingsManager.getLoggingSettings());
	const startedAt = Date.now();
	const cliVersion = readCliVersion();
	const channelRunners = new Map<string, AgentRunner>();
	const sessionResetChains = new Map<string, Promise<void>>();
	const activeTasks = new Set<Promise<void>>();
	/** Channels with a `/stop` watchdog in flight, so a burst of `/stop` starts only one. */
	const stopWatchdogs = new Set<string>();
	// `workspace/CHANNELS.md`: names every channel id so the workspace, the logs and the agent
	// stop dealing in `group_cid...`. Writes are debounced internally (see channel-index.ts).
	const channelIndex: ChannelIndex = createChannelIndex({ workspaceDir: options.paths.workspaceDir });
	let durableDispatch: DurableDispatchService | undefined;
	let shuttingDown = false;
	let shutdownPromise: Promise<void> | null = null;

	const archiveIncomingMessage = async (
		channelId: string,
		message: {
			date: string;
			ts: string;
			user: string;
			userName?: string;
			text: string;
			isBot: boolean;
			deliveryMode?: "steer" | "followUp";
			skipContextSync?: boolean;
		},
		contextLabel: string,
	): Promise<void> => {
		try {
			await store.logMessage(channelId, message);
		} catch (err) {
			log.logWarning(`[${channelId}] Failed to archive ${contextLabel}`, errorMessage(err));
		}
	};

	const getRunner = (channelId: string): AgentRunner => {
		const existing = channelRunners.get(channelId);
		if (existing) {
			// Re-insert to move this channel to the end (most-recently-used) of the Map's
			// iteration order, which evictIdleRunnersOverCap relies on.
			channelRunners.delete(channelId);
			channelRunners.set(channelId, existing);
			return existing;
		}

		const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
		ensureChannelMemoryFilesSync(channelDir);
		const runner = createRunner(channelId, channelDir, {
			appHomeDir: options.paths.appHomeDir,
			authConfigPath: options.paths.authConfigPath,
			modelsConfigPath: options.paths.modelsConfigPath,
			settingsManager: runtimeSettingsManager,
			onSessionEvent: options.observer,
			// The DingTalk bot is the media sender for this transport; enables `send_media`.
			// `bot` is defined below in this same scope and initialized before any message
			// (and thus any getRunner call) can arrive.
			mediaSender: bot,
		});
		channelRunners.set(channelId, runner);
		void evictIdleRunnersOverCap(channelRunners);
		return runner;
	};

	const handler: DingTalkHandler = {
		isRunning(channelId: string): boolean {
			return channelRunners.get(channelId)?.isBusy() ?? false;
		},

		noteChannelActivity(observation): void {
			if (shuttingDown) return;
			channelIndex.note(observation);
		},

		async handleStop(channelId: string, _bot: DingTalkBot): Promise<StopOutcome> {
			const runner = channelRunners.get(channelId);
			let pausedTaskId: string | undefined;
			if (runner?.isBusy()) {
				runner.requestStop();
				const taskId = /^\[TASK_DRIVER:([A-Za-z0-9._-]+)\]/.exec(runner.getTurnStatus().taskText ?? "")?.[1];
				if (taskId) {
					const pauseResult = await pauseTask(
						{
							args: "",
							channelDir: getChannelDir(options.paths.workspaceDir, channelId),
						},
						taskId,
					);
					pausedTaskId = taskId;
					log.logInfo(`[${channelId}] ${pauseResult}`);
				}
				_bot.discardCard(channelId);
				// Drop queued-but-not-started messages so a burst does not keep
				// running after the user asked to halt; abort the in-flight one.
				const dropped = _bot.clearPendingMessages(channelId);
				if (dropped > 0) {
					log.logInfo(`[${channelId}] Dropped ${dropped} queued message(s) on stop`);
				}
				void runner.abort().catch((err) => {
					log.logWarning(`[${channelId}] Failed to abort run`, errorMessage(err));
				});
				void durableDispatch
					?.cancelChannel(channelId)
					.then((canceled) => {
						if (canceled) log.logInfo(`[${channelId}] Reset ${canceled} durable-dispatch lease(s) on stop`);
					})
					.catch((err) => {
						log.logWarning(`[${channelId}] Failed to reset durable-dispatch leases on stop`, errorMessage(err));
					});
				log.logInfo(`[${channelId}] Stop requested`);
				if (!stopWatchdogs.has(channelId)) {
					stopWatchdogs.add(channelId);
					void forceEndStuckTurnAfterStop({
						channelId,
						runner,
						graceMs: options.stopForceEndGraceMs,
						notify: (text) => _bot.sendPlain(channelId, text),
					})
						.catch((err) => {
							log.logWarning(`[${channelId}] Stop watchdog failed`, errorMessage(err));
						})
						.finally(() => {
							stopWatchdogs.delete(channelId);
						});
				}
			}
			return { pausedTaskId };
		},

		async handleNewSession(event: ChannelEvent, _bot: DingTalkBot): Promise<void> {
			if (shuttingDown) return;
			const previous = sessionResetChains.get(event.channelId) ?? Promise.resolve();
			const reset = previous
				.catch(() => undefined)
				.then(async () => {
					try {
						const channelDir = ensureChannelDir(options.paths.workspaceDir, event.channelId);
						ensureChannelMemoryFilesSync(channelDir);
						const access = resolveProjectAccessPolicy(
							loadSecurityConfigWithDiagnostics(options.paths.appHomeDir).config,
							process.cwd(),
						);
						const scope = resolveProjectScope(channelDir, access);
						if (scope.kind === "blocked") {
							throw new Error(scope.reason);
						}

						// The empty session file and active pointer are committed before the old
						// generation is touched. A filesystem failure therefore leaves the live
						// session authoritative and retryable.
						const result = await createFreshActiveSession(channelDir, scope.scope.projectRoot);
						const oldRunner = channelRunners.get(event.channelId);
						if (oldRunner) {
							channelRunners.delete(event.channelId);
							try {
								oldRunner.retireForNewSession?.();
							} catch (error) {
								// The active pointer already names the new session. Retirement is
								// best-effort cleanup and must not misreport the committed reset as failed.
								log.logWarning(
									`[${event.channelId}] Old runner retirement failed after /new`,
									errorMessage(error),
								);
							}
						}
						const dropped = _bot.resetChannelQueue(event.channelId);
						if (dropped > 0) {
							log.logInfo(`[${event.channelId}] /new discarded ${dropped} queued old-session message(s)`);
						}
						await _bot.sendPlain(event.channelId, `已开启新会话。\n\nSession ID: \`${result.sessionId}\``);
						void archiveIncomingMessage(
							event.channelId,
							{
								date: new Date().toISOString(),
								ts: event.ts,
								user: event.user,
								userName: event.userName,
								text: event.text,
								isBot: false,
							},
							"/new command",
						);
					} catch (error) {
						const message = errorMessage(error);
						log.logWarning(`[${event.channelId}] Failed to create a fresh session`, message);
						await _bot.sendPlain(
							event.channelId,
							`新会话创建失败：${message}\n\n旧会话仍保持不变；请重试 \`/new\`。`,
						);
					}
				});
			sessionResetChains.set(event.channelId, reset);
			activeTasks.add(reset);
			try {
				await reset;
			} finally {
				activeTasks.delete(reset);
				if (sessionResetChains.get(event.channelId) === reset) {
					sessionResetChains.delete(event.channelId);
				}
			}
		},

		async runRuntimeCommand(event: ChannelEvent, name: RuntimeCommandName, args: string): Promise<string> {
			switch (name) {
				case "events":
					return runEventsCommand({
						args,
						workspaceDir: options.paths.workspaceDir,
						historyPath: options.paths.eventHistoryPath,
					});
				case "tasks":
					return runTasksCommand({
						args,
						channelDir: getChannelDir(options.paths.workspaceDir, event.channelId),
						workspaceDir: options.paths.workspaceDir,
						channelId: event.channelId,
						dispatchTask: async (id) => {
							const channelDir = getChannelDir(options.paths.workspaceDir, event.channelId);
							const entry = (await readActiveTasks(join(channelDir, "tasks"))).find(
								(candidate) => candidate.id === id,
							);
							if (!entry) return false;
							// A human asking to run a task twice means twice, so this key is deliberately
							// unique per invocation rather than sharing the driver's occurrence key (D1).
							const now = Date.now();
							const driverEvent = createTaskDriverEvent(event.channelId, entry, now);
							return (
								(await durableDispatch?.dispatch({
									...driverEvent,
									dispatchId: `task:${event.channelId}:${entry.id}:manual:${new Date(now).toISOString()}`,
								})) ?? false
							);
						},
					});
				case "status":
					return renderStatus({
						runner: channelRunners.get(event.channelId),
						version: cliVersion,
						uptimeMs: Date.now() - startedAt,
					});
				case "usage":
					return renderUsageReport(getUsageLedger(), event.channelId, parseUsageMode(args), new Date());
				// Read-only prompt accounting; safe mid-turn, so the busy path answers it through
				// this stateless report rather than the runner's ChannelContext-aware idle path.
				case "context":
					return getRunner(event.channelId).renderContextReport(args);
				// A human control path independent of the model (spec 040, D6): `/stop` no longer kills a
				// dispatched delegation, so cancel must work whether or not a runner is currently active.
				case "subagents":
					return runSubagentsCommand({
						args,
						channelId: event.channelId,
						discovery: channelRunners.get(event.channelId)?.getSubAgentDiscoverySnapshot(),
						// `roles` needs a role directory even for a channel that has never spoken this boot —
						// resolved from disk, without spinning up a full ChannelRunner (spec 041).
						getDetachedDiscovery: () =>
							loadDetachedSubAgentDiscovery({
								workspaceDir: options.paths.workspaceDir,
								authConfigPath: options.paths.authConfigPath,
								modelsConfigPath: options.paths.modelsConfigPath,
							}),
					});
				case "project":
					return runProjectCommand({
						args,
						channelId: event.channelId,
						channelDir: getChannelDir(options.paths.workspaceDir, event.channelId),
						appHomeDir: options.paths.appHomeDir,
						actor: "dingtalk-command",
						isBusy: () => channelRunners.get(event.channelId)?.isBusy() ?? false,
						listActiveBlockers: () => [
							...getSubAgentRunManager(event.channelId)
								.list()
								.filter((record) => record.status === "running")
								.map((record) => `subagent run \`${record.runId}\` (${record.agent})`),
							...channelRunningJobLines(event.channelId),
						],
						// D4.2: dispose the cached runner so the next access rebuilds it under the new scope.
						// The active-session ref is untouched — same session, new project root.
						onScopeChanged: async () => {
							const runner = channelRunners.get(event.channelId);
							channelRunners.delete(event.channelId);
							await runner?.dispose().catch((err) => {
								log.logWarning(
									`[${event.channelId}] Failed to dispose runner after /project`,
									errorMessage(err),
								);
							});
						},
					});
				case "skills":
					return runSkillsCommand({
						args,
						workspaceDir: options.paths.workspaceDir,
						appHomeDir: options.paths.appHomeDir,
						channelId: event.channelId,
					});
			}
		},

		async handleBusyMessage(
			event: ChannelEvent,
			bot: DingTalkBot,
			mode: BusyMessageMode,
			queueText: string,
		): Promise<BusyMessageResult> {
			if (shuttingDown) {
				return { kind: "handled" };
			}

			const runner = getRunner(event.channelId);
			const trimmedQueueText = queueText.trim();

			if (!trimmedQueueText) {
				const commandName = mode === "followUp" ? "followup" : "steer";
				await bot.sendPlain(event.channelId, `无法排队：/${commandName} 需要带上消息内容。`);
				return { kind: "handled" };
			}

			// Compaction is maintenance, not user work. A new message cancels it and is
			// kept as a normal queued turn instead of trying to steer an agent loop that
			// is currently disconnected for summarization.
			if (runner.interruptCompaction?.()) {
				log.logInfo(`[${event.channelId}] Interrupted compaction for a new user message`);
				return { kind: "requeue", text: trimmedQueueText };
			}

			if (mode === "followUp") {
				log.logEvent("info", "agent.turn.followup_queued", "Follow-up queued", {
					ctx: { channelId: event.channelId, userName: event.userName },
					fields: { messageLength: trimmedQueueText.length },
				});
				return { kind: "requeue", text: trimmedQueueText };
			}

			try {
				await runner.queueSteer(trimmedQueueText, event.userName);

				await archiveIncomingMessage(
					event.channelId,
					{
						date: new Date().toISOString(),
						ts: event.ts,
						user: event.user,
						userName: event.userName,
						text: event.text,
						isBot: false,
						deliveryMode: mode,
						skipContextSync: true,
					},
					`${mode} message`,
				);

				const confirmation = event.text.trim().startsWith("/")
					? "已作为 steer 排队，当前工具步骤结束后生效。"
					: "已作为 steer 排队，当前工具步骤结束后生效。想等整个回合结束再执行，用 `/followup <消息>`。";
				await bot.sendPlain(event.channelId, confirmation);
				log.logEvent("info", "agent.turn.steer_queued", "Steer queued", {
					ctx: { channelId: event.channelId, userName: event.userName },
					fields: { messageLength: trimmedQueueText.length },
				});
				return { kind: "handled" };
			} catch (err) {
				const errMsg = errorMessage(err);
				if (isNoRunningTaskQueueError(err)) {
					log.logInfo(`[${event.channelId}] Busy ${mode} window closed; requeueing as a normal message`);
					return { kind: "requeue", text: trimmedQueueText };
				}
				log.logWarning(`[${event.channelId}] Failed to queue ${mode}`, errMsg);
				await bot.sendPlain(event.channelId, `无法排队这条消息：${errMsg}`);
				return { kind: "handled" };
			}
		},

		reserveEvent(event: ChannelEvent): void {
			// This must remain synchronous. DingTalkBot calls it before awaiting the queued
			// handler, making the busy state observable to another message in the same tick.
			getRunner(event.channelId).beginTurn(event.text);
		},

		async handleEvent(event: ChannelEvent, bot: DingTalkBot, _isEvent?: boolean): Promise<void> {
			if (shuttingDown) {
				log.logInfo(`[${event.channelId}] Ignoring event during shutdown`);
				return;
			}

			const runner = getRunner(event.channelId);
			await durableDispatch?.markStarted(event.dispatchId);
			let structuredWakeFinalized = event.internalWake === undefined;
			const task = (async () => {
				try {
					// Computed before archiving so a command's own text can be excluded from
					// memory-extraction input (review 2026-08-24 §1.2): it is control-plane
					// traffic, not conversation, and the history stays queryable via session_search.
					const builtInCommand = parseBuiltInCommand(event.text);
					await archiveIncomingMessage(
						event.channelId,
						{
							date: new Date().toISOString(),
							ts: event.ts,
							user: event.user,
							userName: event.userName,
							text: event.text,
							isBot: false,
							skipContextSync: Boolean(builtInCommand),
						},
						"user message",
					);

					// Background wakes deliver their result, not their process: no progress card, no
					// thinking stream, nothing to delete when the check-in ends `[SILENT]`. An "awaited"
					// wake (a delegation or job finishing) is the opposite — a human is actually waiting
					// on it — so it renders progress the same way a normal message does (P0-2).
					const backgroundOnly = Boolean(_isEvent) && event.presentation !== "awaited";
					const ctx = createDingTalkContext(event, bot, store, backgroundOnly ? "none" : undefined);

					if (builtInCommand) {
						const commandStartedAt = Date.now();
						const logCtx = { channelId: event.channelId, userName: event.userName };
						log.logEvent("info", "runtime.command.started", "Executing command", {
							ctx: logCtx,
							fields: { command: builtInCommand.name },
						});
						try {
							if (isIdleRuntimeCommandName(builtInCommand.name)) {
								const response = await handler.runRuntimeCommand(
									event,
									builtInCommand.name,
									builtInCommand.args,
								);
								const delivered = await bot.sendPlain(event.channelId, response, {
									title: `/${builtInCommand.name}`,
									markdown: true,
								});
								if (!delivered) {
									log.logWarning(
										`[${event.channelId}] Failed to deliver /${builtInCommand.name} reply`,
										`${response.length} chars`,
									);
								}
							} else if (isRunnerBuiltInCommand(builtInCommand)) {
								await runner.handleBuiltinCommand(ctx, builtInCommand);
							}
							log.logEvent("info", "runtime.command.completed", "Command completed", {
								ctx: logCtx,
								fields: { command: builtInCommand.name, durationMs: Date.now() - commandStartedAt },
							});
						} catch (err) {
							log.logEvent("warn", "runtime.command.failed", "Command failed", {
								ctx: logCtx,
								fields: {
									command: builtInCommand.name,
									durationMs: Date.now() - commandStartedAt,
									error: errorMessage(err),
								},
							});
							throw err;
						}
						return;
					}

					// Reject an unknown slash command instead of spending a full LLM turn
					// letting the model guess what `/modle` meant. Session commands,
					// skills, and prompt templates are recognized by isKnownSlashCommand.
					if (event.text.trim().startsWith("/") && !runner.isKnownSlashCommand(event.text)) {
						const name = slashCommandName(event.text) ?? "";
						await bot.sendPlain(event.channelId, formatUnknownCommandMessage(name));
						return;
					}

					log.logEvent("info", "agent.turn.started", "Starting turn", {
						ctx: { channelId: event.channelId, userName: event.userName },
						fields: { messageLength: event.text.length, source: _isEvent ? "event" : "message" },
					});
					if (!backgroundOnly) {
						ctx.primeCard(350);
					}
					// Effects are tallied per channel; the governor needs them per task, so one
					// task-driver turn is measured as a delta (turns on a channel are serialized)
					// and credited to the task it was dispatched for.
					const effectsBefore = channelEffectCount(event.channelId);
					// Both wake formats below carry an unauthenticated claim in plain text: anything
					// that can put a message on this channel can *write* "[JOB:x] ... belongs to task
					// y." or "[SUBAGENT:x] ... belongs to task y." — including another user, or an
					// external agent's own untrusted stdout (spec 040, D8's threat model explicitly
					// treats external output as untrusted). Activating a waiting task on text pattern
					// alone lets that forged claim wake an unrelated task early. The
					// pattern match only extracts a *candidate* id pair now; both paths verify the
					// named run/job actually exists, is done, and really is the one that names this
					// taskId before ever calling `activateWaitingTask` (T9).
					const jobTextMatch = /^\[JOB:([^\]]+)\][\s\S]*?belongs to task ([A-Za-z0-9._-]+)\./.exec(event.text);
					const jobMatch =
						event.internalWake?.kind === "job"
							? [event.text, event.internalWake.resourceId, event.internalWake.taskId]
							: jobTextMatch;
					let recoveredJobTaskId: string | undefined;
					if (jobMatch) {
						const [, jobId, jobTaskId] = jobMatch;
						const claimed = await claimVerifiedJobWake(
							event,
							options.paths.workspaceDir,
							executor,
							options.wakeTransitionHooks?.job,
						);
						if (claimed) {
							if (claimed.activated) recoveredJobTaskId = claimed.taskId;
							await claimed.finish();
							structuredWakeFinalized = true;
							// Drop without a turn only when something else is still driving this task (a
							// sibling wake in the same fan-out already activated it); every other case —
							// the task is done, archived, disabled, or gone — has nobody left to see this
							// result if it is dropped here, so it must still reach a normal turn (P3-1).
							if (event.internalWake?.kind === "job" && !claimed.activated && claimed.taskStillDriven) return;
						} else {
							log.logWarning(
								`[${event.channelId}] Ignored an unverifiable [JOB:${jobId}] wake claiming task ${jobTaskId}`,
							);
							if (event.internalWake?.kind === "job") {
								structuredWakeFinalized = true;
								return;
							}
						}
					}
					// Spec 040, D7: a delegation run's completion wake carries the same "belongs to
					// task" contract as a background job's, and reactivates a task parked with
					// waitingFor="external-signal" the same way — verified the same way (T9).
					const delegationTextMatch = /^\[SUBAGENT:([^\]]+)\][\s\S]*?belongs to task ([A-Za-z0-9._-]+)\./.exec(
						event.text,
					);
					const delegationMatch =
						event.internalWake?.kind === "subagent"
							? [event.text, event.internalWake.resourceId, event.internalWake.taskId]
							: delegationTextMatch;
					let recoveredDelegationTaskId: string | undefined;
					if (delegationMatch) {
						const [, runId, delegationTaskId] = delegationMatch;
						const claimed = await claimVerifiedDelegationWake(
							event,
							options.paths.workspaceDir,
							options.wakeTransitionHooks?.subagent,
						);
						if (claimed) {
							if (claimed.activated) recoveredDelegationTaskId = claimed.taskId;
							await claimed.finish();
							structuredWakeFinalized = true;
							// See the JOB branch above (P3-1): only skip the turn when the task is still
							// driven by something else.
							if (event.internalWake?.kind === "subagent" && !claimed.activated && claimed.taskStillDriven)
								return;
						} else {
							log.logWarning(
								`[${event.channelId}] Ignored an unverifiable [SUBAGENT:${runId}] wake claiming task ${delegationTaskId}`,
							);
							if (event.internalWake?.kind === "subagent") {
								structuredWakeFinalized = true;
								return;
							}
						}
					}
					const result = await runner.run(ctx, store);
					const taskDriverMatch = /^\[TASK_DRIVER:([A-Za-z0-9._-]+)\]/.exec(event.text);
					const taskAttemptId = taskDriverMatch?.[1] ?? recoveredJobTaskId ?? recoveredDelegationTaskId;
					// The three sources above are mutually exclusive (each regex is anchored at the
					// start of a distinct prefix), so crediting effects to whichever one matched is
					// equivalent to checking all three separately.
					if (taskAttemptId) {
						noteTaskEffects(event.channelId, taskAttemptId, channelEffectCount(event.channelId) - effectsBefore);
					}

					if (result.stopReason === "aborted" && runner.getTurnStatus().stopRequested) {
						log.logInfo(`[${event.channelId}] Stopped`);
					}
				} catch (err) {
					log.logEvent("error", "agent.turn.failed", "Turn failed", {
						ctx: { channelId: event.channelId, userName: event.userName },
						fields: { error: errorMessage(err) },
					});
				} finally {
					if (structuredWakeFinalized) await durableDispatch?.markCompleted(event.dispatchId);
					else await durableDispatch?.markRetryable(event.dispatchId);
					runner.endTurn();
					// A finished turn may have written task files (progress/complete/set); rescan
					// now so a continuing task chain advances immediately instead of after a full sleep.
					taskDriver.nudge?.();
				}
			})();

			activeTasks.add(task);
			try {
				await task;
			} finally {
				activeTasks.delete(task);
			}
		},
	};

	const bot = options.createBot
		? options.createBot(handler, options.dingtalkConfig)
		: new DingTalkBot(handler, options.dingtalkConfig);
	durableDispatch = new DurableDispatchService({
		stateDir: join(options.paths.appHomeDir, "state", "dispatch"),
		bot,
		// A structured wake (job/subagent completion, task-driver) that keeps failing before it can
		// ever mark itself complete would otherwise redeliver forever (30s tick, no backoff prior to
		// this notice). Surface it once instead of looping silently; the record stays on disk for
		// inspection until a human clears it.
		onExhausted: async (record) => {
			log.logWarning(
				`[${record.event.channelId}] Dispatch ${record.id} exhausted after ${record.deliveries} deliveries`,
				record.event.text.slice(0, 500),
			);
			await bot.sendPlain(
				record.event.channelId,
				`一个后台唤醒（${record.event.user}）连续 ${record.deliveries} 次投递均未能完成，已停止自动重试：\n` +
					`${record.event.text.slice(0, 300)}\n` +
					`记录文件：state/dispatch/${record.id}.json（已保留，供排查）。`,
			);
		},
	});
	const executor = createExecutor();
	// Background jobs get their persistence root and their way to wake a channel before any turn
	// can start one, then re-adopt whatever survived the last shutdown (spec 031, D6).
	configureJobRuntime({
		jobsStateDir: join(options.paths.appHomeDir, "state", "jobs"),
		dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
	});
	// Delegation runs get the same treatment (spec 040, D1/D7): persistence root, wake delivery,
	// and the usage/archive authority, wired before any turn can start a run.
	configureSubAgentRuntime({
		stateDir: join(options.paths.appHomeDir, "state", "subagent-runs"),
		dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
		// P0-1/P1a: a best-effort out-of-band notice, independent of the completion wake — it reaches
		// the channel in roughly the time the run itself takes, not the wake turn's own LLM latency
		// on top of that. `notices: "off"` (settings.json) restores today's silent behavior.
		notify: (channelId, notice) => {
			const level = runtimeSettingsManager.getDelegationSettings().notices;
			if (level === "off") return;
			if (level === "settled" && notice.kind !== "settled") return;
			const text = renderRunNotice(notice);
			if (text) void bot.sendPlain(channelId, text);
		},
		ledger: getUsageLedger(),
		store,
	});
	// Admission (bot.start() below) must not open until every persisted job and run is back in
	// memory: a message arriving mid-restore would see partial running-count/short-id/lease state,
	// and durableDispatch's redelivery of a pending completion wake would find no record to claim.
	// Spec 042 D11: `restoreChannelJobs` used to be a bare `void` while `restoreAllSubAgentRuns`
	// was already awaited — the same admission race P0-1 closed for delegation runs was still open
	// for background jobs.
	await restoreChannelJobs(executor);
	await restoreAllSubAgentRuns();
	// Spec 043, D10 point 1: repair any turn interrupted by the last shutdown/crash before opening
	// admission — a message routed to a still-dangling session would 400 against the provider on
	// every attempt (F3) until a human ran /new. Runs before bot.start() for the same reason as
	// the job/run restores above: admission must see a structurally legal session, not a partial one.
	const recoveryReport = await scanWorkspaceForInterruptedTurns(options.paths.workspaceDir, {
		api: defaultModel.api,
		provider: defaultModel.provider,
		model: defaultModel.id,
	});
	if (recoveryReport.repaired.length > 0) {
		log.logWarning(
			"Repaired interrupted turns on restart",
			`${recoveryReport.repaired.length}/${recoveryReport.scanned} channel(s): ${recoveryReport.repaired
				.map((r) => r.channelDir)
				.join(", ")}`,
		);
	}
	if (recoveryReport.blocked.length > 0) {
		log.logWarning(
			"Some channels have an unrecoverable session and will refuse new turns",
			recoveryReport.blocked.map((b) => `${b.channelDir}: ${b.reason}`).join("; "),
		);
	}
	const eventsWatcher = options.createEventsWatcher
		? options.createEventsWatcher(options.paths.workspaceDir, bot, executor, options.paths.eventHistoryPath)
		: createEventsWatcher(
				options.paths.workspaceDir,
				bot,
				executor,
				loadSecurityConfigWithDiagnostics(options.paths.appHomeDir).config.commandGuard,
				options.paths.eventHistoryPath,
				(event) => durableDispatch?.dispatch(event) ?? false,
			);
	const memoryMaintenanceScheduler = options.createMemoryMaintenanceScheduler
		? options.createMemoryMaintenanceScheduler()
		: new MemoryMaintenanceScheduler({
				appHomeDir: options.paths.appHomeDir,
				workspaceDir: options.paths.workspaceDir,
				getKnownChannelIds: () => channelRunners.keys(),
				// Channels active this boot reuse their runner's in-memory context; every
				// other discovered channel gets a lightweight disk-backed context instead
				// of resurrecting a full ChannelRunner (session, tools, sub-agents) that
				// would then sit in the runner cache forever.
				getRuntimeContext: async (channelId) => {
					const runner = channelRunners.get(channelId);
					if (runner) {
						return runner.getMemoryMaintenanceContext();
					}
					return loadDetachedMaintenanceContext({
						channelId,
						channelDir: getChannelDir(options.paths.workspaceDir, channelId),
						authConfigPath: options.paths.authConfigPath,
						modelsConfigPath: options.paths.modelsConfigPath,
						settingsManager: runtimeSettingsManager,
					});
				},
				isChannelActive: (channelId) => channelRunners.get(channelId)?.isBusy() ?? false,
				getSettings: () => {
					runtimeSettingsManager.reload();
					return {
						memoryMaintenance: runtimeSettingsManager.getMemoryMaintenanceSettings(),
						sessionMemory: runtimeSettingsManager.getSessionMemorySettings(),
					};
				},
				intervalMs: options.memoryMaintenanceSchedulerIntervalMs,
			});
	// `tools.json` is re-read on every driver tick — and a tick follows every turn — so cache the
	// parse behind the file's change token. `settings.json` gets the same treatment inside
	// `PipiclawSettingsManager.reload()`, which is why the getSettings closure below stays as-is.
	let cachedToolsStamp: string | undefined;
	let cachedTasksEnabled = true;
	const tasksToolEnabled = (): boolean => {
		const stamp = fileStamp(getToolsConfigPath(options.paths.appHomeDir));
		if (stamp !== cachedToolsStamp) {
			cachedToolsStamp = stamp;
			cachedTasksEnabled = loadToolsConfig(options.paths.appHomeDir).tools.tasks.enabled;
		}
		return cachedTasksEnabled;
	};
	const taskDriver = options.createTaskDriver
		? options.createTaskDriver()
		: new TaskDriver({
				workspaceDir: options.paths.workspaceDir,
				getKnownChannelIds: () => channelRunners.keys(),
				isChannelActive: (channelId) => channelRunners.get(channelId)?.isBusy() ?? false,
				dispatch: (event) => durableDispatch?.dispatch(event) ?? false,
				onDispatch: options.onTaskDriverDispatch,
				getEffectCount: taskEffectCount,
				notify: (receipt) => bot.sendPlain(receipt.channelId, receipt.text),
				getSettings: () => {
					runtimeSettingsManager.reload();
					return runtimeSettingsManager.getTaskDriverSettings();
				},
				isEnabled: tasksToolEnabled,
			});

	const shutdownWithReason = async (reason: NodeJS.Signals | "manual" = "manual"): Promise<void> => {
		if (shutdownPromise) {
			return shutdownPromise;
		}

		shutdownPromise = (async () => {
			shuttingDown = true;
			log.logInfo(`Shutting down (${reason})...`);

			taskDriver.stop();
			durableDispatch?.stop();
			memoryMaintenanceScheduler.stop();
			eventsWatcher.stop();
			stopSubAgentGarbageCollector();
			await bot.stop();

			const runningTasks = Array.from(activeTasks);
			if (runningTasks.length > 0) {
				log.logInfo(`Waiting for ${runningTasks.length} active task(s) to finish`);
				const completed = await waitForTasks(runningTasks, SHUTDOWN_WAIT_MS);

				if (!completed) {
					log.logWarning(`Shutdown grace period exceeded ${SHUTDOWN_WAIT_MS}ms, aborting active runs`);
					const aborts: Promise<void>[] = [];
					for (const [channelId, runner] of channelRunners) {
						if (!runner.isBusy()) continue;
						runner.requestStop();
						log.logInfo(`[${channelId}] Aborting active run for shutdown`);
						aborts.push(
							runner.abort().catch((err) => {
								log.logWarning(`[${channelId}] Failed to abort run during shutdown`, errorMessage(err));
							}),
						);
					}
					await Promise.allSettled(aborts);

					const remainingTasks = Array.from(activeTasks);
					if (remainingTasks.length > 0) {
						const abortedCompleted = await waitForTasks(remainingTasks, SHUTDOWN_ABORT_WAIT_MS);
						if (!abortedCompleted) {
							log.logWarning(`Shutdown forced exit with ${remainingTasks.length} task(s) still active`);
						}
					}
				}
			}

			// Idle runners are disposed (flush memory, unsubscribe, release the SDK session); a
			// still-busy one — its turn already aborted above — is just dropped from the cache and
			// left to unwind on its own as the process exits.
			const disposals: Promise<void>[] = [];
			for (const [channelId, runner] of channelRunners) {
				if (runner.isBusy()) continue;
				disposals.push(
					runner.dispose().catch((err) => {
						log.logWarning(`[${channelId}] Failed to dispose runner during shutdown`, errorMessage(err));
					}),
				);
			}
			if (disposals.length > 0) {
				log.logInfo(`Disposing ${disposals.length} idle channel runner(s) before shutdown`);
				const disposed = await waitForTasks(disposals, SHUTDOWN_FLUSH_WAIT_MS);
				if (!disposed) {
					log.logWarning(`Shutdown runner disposal exceeded ${SHUTDOWN_FLUSH_WAIT_MS}ms`);
				}
			}
			channelRunners.clear();

			const storageFlushes = [
				store.close(),
				// Cancels the debounce timer and lands the last activity times.
				channelIndex.close(),
				getUsageLedger().flush?.() ?? Promise.resolve(),
				flushSecurityLogs(),
				...(eventsWatcher.flush ? [eventsWatcher.flush()] : []),
			];
			const storageFlushed = await waitForTasks(storageFlushes, SHUTDOWN_LOG_FLUSH_WAIT_MS);
			if (!storageFlushed) {
				log.logWarning(`Shutdown log flush exceeded ${SHUTDOWN_LOG_FLUSH_WAIT_MS}ms`);
			}
			await waitForTasks([log.flushLogging()], SHUTDOWN_LOG_FLUSH_WAIT_MS);
		})();

		return shutdownPromise;
	};

	if (registerSignalHandlers) {
		process.once("SIGINT", () => {
			void shutdownWithReason("SIGINT").finally(() => {
				process.exit(0);
			});
		});

		process.once("SIGTERM", () => {
			void shutdownWithReason("SIGTERM").finally(() => {
				process.exit(0);
			});
		});
	}

	if (startServices) {
		// Close the 027/038 migration windows: fold any residual legacy `.schedule` events into task
		// frontmatter, and upgrade any task still on the legacy control/status vocabulary, before the
		// driver relies on the current contract alone. Version-gated, not marker-gated (spec 043,
		// phase 5): each file is judged by what it actually contains, so this is safe and cheap to run
		// on every startup — a hand-edited or freshly-restored legacy file self-heals on the next boot.
		void Promise.all([
			migrateLegacyTaskScheduleEvents(options.paths.workspaceDir),
			migrateLegacyTaskState(options.paths.workspaceDir),
		]);
		eventsWatcher.start();
		memoryMaintenanceScheduler.start();
		taskDriver.start();
		durableDispatch.start();
		void bot.start();
	}

	return {
		handler,
		store,
		bot,
		taskDriver,
		memoryMaintenance: memoryMaintenanceScheduler,
		shutdown: shutdownWithReason,
	};
}

/**
 * Transport-neutral app services shared by the DingTalk runtime and the terminal
 * TUI: loads settings (surfacing load errors) and reports tool/security config
 * diagnostics. Does NOT touch DingTalk config, so the TUI can call it without any
 * DingTalk credentials.
 *
 * Extracted verbatim from `bootstrap()`; the DingTalk path calls it in the same
 * position (after `loadConfig`, before `logStartup`) so its behavior is
 * unchanged. Logging configuration is intentionally left to each caller
 * (DingTalk: `createRuntimeContext`; TUI: right after this) to preserve the
 * existing "diagnostics logged with default logging config" ordering.
 */
export function prepareAppServices(paths: BootstrapPaths = DEFAULT_BOOTSTRAP_PATHS): {
	settingsManager: PipiclawSettingsManager;
} {
	// Shared by the DingTalk daemon and the TUI (both call prepareAppServices), so this
	// covers every entrypoint that talks to an LLM provider.
	installLlmProxy();

	const settingsManager = new PipiclawSettingsManager(paths.appHomeDir);
	for (const { scope, error } of settingsManager.drainErrors()) {
		log.logWarning(`Failed to load ${scope} settings`, `${error.message}\n${paths.settingsConfigPath}`);
	}
	// Errors already went out above with a richer message; this pass exists for the
	// warnings, chiefly retired settings keys (spec 035 D3).
	for (const diagnostic of settingsManager.getDiagnostics()) {
		if (diagnostic.severity === "error") continue;
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}
	for (const diagnostic of loadToolsConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}
	for (const diagnostic of loadSecurityConfigWithDiagnostics(paths.appHomeDir).diagnostics) {
		log.logWarning(formatConfigDiagnostic(diagnostic), diagnostic.path);
	}

	return { settingsManager };
}

export async function bootstrap(argv: string[], options: BootstrapOptions = {}): Promise<AppContext> {
	const io = options.io ?? console;
	const paths = options.paths ?? DEFAULT_BOOTSTRAP_PATHS;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const startServices = options.startServices ?? true;

	parseArgs(argv, paths, io);
	const bootstrapResult = bootstrapAppHome(paths);
	printBootstrapSummary(bootstrapResult, io, paths);

	if (bootstrapResult.channelTemplateCreated) {
		io.error(`Fill in ${paths.channelConfigPath} and run \`${paths.appName}\` again.`);
		throw new BootstrapExitError(1);
	}

	const dingtalkConfig = loadConfig(paths, io);
	dingtalkConfig.stateDir = paths.workspaceDir;
	const { settingsManager } = prepareAppServices(paths);

	log.logStartup(paths.workspaceDir);
	const runtime = await createRuntimeContext({
		paths,
		dingtalkConfig,
		registerSignalHandlers,
		startServices,
		settingsManager,
	});

	return {
		bot: runtime.bot,
		store: runtime.store,
		shutdown: async () => {
			await runtime.shutdown("manual");
		},
	};
}
