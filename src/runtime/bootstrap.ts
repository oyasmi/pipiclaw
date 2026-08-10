import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
	formatUnknownCommandMessage,
	isRunnerBuiltInCommand,
	parseBuiltInCommand,
	type RuntimeCommandName,
	slashCommandName,
} from "../agent/commands.js";
import { channelEffectCount, noteTaskEffects, taskEffectCount } from "../agent/effect-ledger.js";
import { type AgentRunner, getOrCreateRunner } from "../agent/index.js";
import { configureJobRuntime, restoreChannelJobs } from "../agent/job-manager.js";
import { loadDetachedMaintenanceContext } from "../agent/maintenance-context.js";
import { resetRunner } from "../agent/runner-factory.js";
import { renderStatus } from "../agent/status-render.js";
import { createExecutor, type Executor } from "../executor.js";
import * as log from "../log.js";
import { ensureChannelMemoryFilesSync } from "../memory/files.js";
import { MemoryMaintenanceScheduler } from "../memory/scheduler.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { flushSecurityLogs } from "../security/logger.js";
import { PipiclawSettingsManager } from "../settings.js";
import { formatConfigDiagnostic } from "../shared/config-diagnostic.js";
import { fileStamp } from "../shared/file-stamp.js";
import { errorMessage } from "../shared/text-utils.js";
import { loadDetachedSubAgentDiscovery } from "../subagents/detached-discovery.js";
import { configureSubAgentRuntime, restoreAllSubAgentRuns, stopSubAgentSweeper } from "../subagents/runs.js";
import { readActiveTasks } from "../tasks/ledger.js";
import { finishTaskAttempt, type WakeTaskTransitionHooks } from "../tasks/store.js";
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
import { type ChannelIndex, createChannelIndex } from "./channel-index.js";
import { ensureChannelDir, getChannelDir } from "./channel-paths.js";
import { createDingTalkContext } from "./delivery.js";
import {
	type BusyMessageMode,
	type BusyMessageResult,
	DingTalkBot,
	type DingTalkConfig,
	type DingTalkEvent,
	type DingTalkHandler,
	type StopOutcome,
} from "./dingtalk.js";
import { DurableDispatchService } from "./durable-dispatch.js";
import { handleEventsCommand as runEventsCommand } from "./event-commands.js";
import { createEventsWatcher } from "./events.js";
import { installLlmProxy } from "./proxy.js";
import { ChannelStore } from "./store.js";
import { handleSubagentsCommand as runSubagentsCommand } from "./subagent-commands.js";
import { pauseTask, handleTasksCommand as runTasksCommand } from "./task-commands.js";
import { createTaskDriverEvent, createTaskVerificationEvent, TaskDriver } from "./task-driver.js";
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

function flushInactiveChannelMemory(channelRunners: Map<string, AgentRunner>): Promise<void>[] {
	const flushes: Promise<void>[] = [];
	for (const [channelId, runner] of channelRunners) {
		if (runner.isBusy()) {
			continue;
		}
		flushes.push(
			runner.flushMemoryForShutdown().catch((err) => {
				log.logWarning(`[${channelId}] Failed to flush memory during shutdown`, errorMessage(err));
			}),
		);
	}
	return flushes;
}

function isNoRunningTaskQueueError(err: unknown): boolean {
	return err instanceof Error && err.message === "No task is currently running.";
}

/**
 * The `runRuntimeCommand` names usable on the idle-turn path. `context` is deliberately excluded:
 * idle answers it through the runner's ChannelContext-aware command path (thread-reply, delete
 * semantics) instead, so it is not part of this stateless-report dispatch here.
 */
const IDLE_RUNTIME_COMMAND_NAMES = new Set<string>(["events", "tasks", "status", "usage", "subagents"]);

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
	onTaskDriverDispatch?: (event: DingTalkEvent, accepted: boolean) => void;
	startServices?: boolean;
	registerSignalHandlers?: boolean;
	/** Test-only fault seams for the atomic structured-wake task transition. */
	wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
	/** Override the `/stop` watchdog's grace window (tests use a short one). */
	stopForceEndGraceMs?: number;
}

export async function createRuntimeContext(
	options: RuntimeContextOptions,
): Promise<RuntimeContext & { bot: DingTalkBot }> {
	const startServices = options.startServices ?? true;
	const registerSignalHandlers = options.registerSignalHandlers ?? true;
	const store = new ChannelStore({ workingDir: options.paths.workspaceDir });
	const runtimeSettingsManager = new PipiclawSettingsManager(options.paths.appHomeDir);
	log.configureLogging(runtimeSettingsManager.getLoggingSettings());
	const startedAt = Date.now();
	const cliVersion = readCliVersion();
	const channelRunners = new Map<string, AgentRunner>();
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
		let runner = channelRunners.get(channelId);
		if (!runner) {
			const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
			ensureChannelMemoryFilesSync(channelDir);
			runner = getOrCreateRunner(channelId, channelDir, {
				appHomeDir: options.paths.appHomeDir,
				authConfigPath: options.paths.authConfigPath,
				modelsConfigPath: options.paths.modelsConfigPath,
				onSessionEvent: options.observer,
				// The DingTalk bot is the media sender for this transport; enables `send_media`.
				// `bot` is defined below in this same scope and initialized before any message
				// (and thus any getRunner call) can arrive.
				mediaSender: bot,
				dispatchVerification: async (taskId) => {
					const entries = await readActiveTasks(join(channelDir, "tasks"));
					const entry = entries.find((candidate) => candidate.id === taskId);
					if (!entry) return false;
					const verificationEvent = createTaskVerificationEvent(channelId, entry, Date.now());
					return (await durableDispatch?.dispatch(verificationEvent)) ?? false;
				},
			});
			channelRunners.set(channelId, runner);
		}
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

		async runRuntimeCommand(event: DingTalkEvent, name: RuntimeCommandName, args: string): Promise<string> {
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
						dispatchTask: async (id, attemptGeneration) => {
							const channelDir = getChannelDir(options.paths.workspaceDir, event.channelId);
							const entry = (await readActiveTasks(join(channelDir, "tasks"))).find(
								(candidate) => candidate.id === id,
							);
							if (!entry) return false;
							// A human asking to run a task twice means twice, so this key is deliberately
							// unique per invocation rather than sharing the driver's occurrence key (D1).
							const now = Date.now();
							const driverEvent = createTaskDriverEvent(event.channelId, entry, now, attemptGeneration);
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
			}
		},

		async handleBusyMessage(
			event: DingTalkEvent,
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

		reserveEvent(event: DingTalkEvent): void {
			// This must remain synchronous. DingTalkBot calls it before awaiting the queued
			// handler, making the busy state observable to another message in the same tick.
			getRunner(event.channelId).beginTurn(event.text);
		},

		async handleEvent(event: DingTalkEvent, bot: DingTalkBot, _isEvent?: boolean): Promise<void> {
			if (shuttingDown) {
				log.logInfo(`[${event.channelId}] Ignoring event during shutdown`);
				return;
			}

			const runner = getRunner(event.channelId);
			await durableDispatch?.markStarted(event.dispatchId);
			let structuredWakeFinalized = event.internalWake === undefined;
			const task = (async () => {
				try {
					await archiveIncomingMessage(
						event.channelId,
						{
							date: new Date().toISOString(),
							ts: event.ts,
							user: event.user,
							userName: event.userName,
							text: event.text,
							isBot: false,
						},
						"user message",
					);

					// Background wakes deliver their result, not their process: no progress card,
					// no thinking stream, nothing to delete when the check-in ends `[SILENT]`.
					const ctx = createDingTalkContext(event, bot, store, _isEvent ? "none" : undefined);
					const builtInCommand = parseBuiltInCommand(event.text);

					if (builtInCommand) {
						log.logEvent("info", "runtime.command.started", "Executing command", {
							ctx: { channelId: event.channelId, userName: event.userName },
							fields: { command: builtInCommand.name },
						});
						if (isIdleRuntimeCommandName(builtInCommand.name)) {
							const response = await handler.runRuntimeCommand(event, builtInCommand.name, builtInCommand.args);
							await bot.sendPlain(event.channelId, response);
							return;
						}
						if (isRunnerBuiltInCommand(builtInCommand)) {
							await runner.handleBuiltinCommand(ctx, builtInCommand);
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
					if (!_isEvent) {
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
					// alone lets that forged claim advance an unrelated task's attempt generation. The
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
							if (claimed.generation !== undefined) event.taskAttemptGeneration = claimed.generation;
							await claimed.finish();
							structuredWakeFinalized = true;
							if (event.internalWake?.kind === "job" && !claimed.activated) return;
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
							if (claimed.generation !== undefined) event.taskAttemptGeneration = claimed.generation;
							await claimed.finish();
							structuredWakeFinalized = true;
							if (event.internalWake?.kind === "subagent" && !claimed.activated) return;
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
					if (taskAttemptId && result.usage && result.durationMs !== undefined) {
						await finishTaskAttempt(getChannelDir(options.paths.workspaceDir, event.channelId), taskAttemptId, {
							tokens: result.usage.total,
							costUsd: result.usage.cost.total,
							costKnown: result.costKnown === true,
							wallTimeMinutes: result.durationMs / 60_000,
							failed: result.stopReason === "error" || result.stopReason === "aborted",
							silent: result.silent,
							finishedAt: new Date(),
							generation: event.taskAttemptGeneration,
						});
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
			stopSubAgentSweeper();
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

			const flushes = flushInactiveChannelMemory(channelRunners);
			if (flushes.length > 0) {
				log.logInfo(`Flushing memory for ${flushes.length} inactive channel(s) before shutdown`);
				const flushed = await waitForTasks(flushes, SHUTDOWN_FLUSH_WAIT_MS);
				if (!flushed) {
					log.logWarning(`Shutdown memory flush exceeded ${SHUTDOWN_FLUSH_WAIT_MS}ms`);
				}
			}

			for (const channelId of channelRunners.keys()) {
				const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
				resetRunner(
					channelId,
					{
						appHomeDir: options.paths.appHomeDir,
						authConfigPath: options.paths.authConfigPath,
						modelsConfigPath: options.paths.modelsConfigPath,
						onSessionEvent: options.observer,
					},
					channelDir,
				);
			}

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
		// One-time close of the 027/038 migration windows: fold any residual legacy `.schedule`
		// events into task frontmatter, and upgrade v1 task status vocabulary, before the driver
		// relies on the v2 contract alone. Both scan every channel's tasks/events, so they are
		// gated on a marker file rather than repeated on every restart once a home has migrated.
		const taskMigrationMarkerPath = join(options.paths.appHomeDir, "state", "task-migration.done");
		if (!existsSync(taskMigrationMarkerPath)) {
			void Promise.all([
				migrateLegacyTaskScheduleEvents(options.paths.workspaceDir),
				migrateLegacyTaskState(options.paths.workspaceDir),
			]).then(() => {
				try {
					mkdirSync(join(options.paths.appHomeDir, "state"), { recursive: true });
					writeFileSync(taskMigrationMarkerPath, `${new Date().toISOString()}\n`);
				} catch (error) {
					log.logWarning("Failed to write task migration marker", errorMessage(error));
				}
			});
		}
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
	prepareAppServices(paths);

	log.logStartup(paths.workspaceDir);
	const runtime = await createRuntimeContext({
		paths,
		dingtalkConfig,
		registerSignalHandlers,
		startServices,
	});

	return {
		bot: runtime.bot,
		store: runtime.store,
		shutdown: async () => {
			await runtime.shutdown("manual");
		},
	};
}
