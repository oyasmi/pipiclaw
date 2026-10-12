/**
 * The daemon's per-channel turn handler: what happens when the DingTalk transport hands the runtime
 * a message, `/stop`, `/new`, a busy-turn message, or a synthetic wake. Wired together (and handed
 * its collaborators) by `bootstrap.ts`.
 */
import { join } from "path";
import type { AgentRunner } from "../agent/types.js";
import type { BootstrapPaths } from "../app/home.js";
import { createFreshActiveSession } from "../channel/active-session-store.js";
import type { ChannelEvent } from "../channel/channel-event.js";
import type { ChannelIndex } from "../channel/channel-index.js";
import { ensureChannelDir, getChannelDir } from "../channel/channel-paths.js";
import { resolveProjectScope } from "../channel/project-scope-store.js";
import type { ChannelStore } from "../channel/store.js";
import {
	formatMissingQueueMessage,
	formatNewSessionReply,
	formatSteerQueued,
	type RuntimeCommandName,
} from "../commands/catalog.js";
import { runReportCommand } from "../commands/router.js";
import type { BusyMessageMode } from "../dingtalk/config.js";
import type { BusyMessageResult, DingTalkBotPort, DingTalkHandler, StopOutcome } from "../dingtalk/handler.js";
import type { JobRuntime } from "../jobs/manager.js";
import * as log from "../log.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { resolveProjectAccessPolicy } from "../security/project-scope.js";
import { errorMessage } from "../shared/text-utils.js";
import type { SubAgentRuntime } from "../subagents/runs.js";
import { readActiveTasks } from "../tasks/contract.js";
import { pauseTask as pauseStoredTask } from "../tasks/store.js";
import type { DurableDispatchService } from "./durable-dispatch.js";
import { persistInboundImage, relativeImagePaths } from "./inbound-images.js";
import { forceEndStuckTurnAfterStop } from "./stop-watchdog.js";
import { createTaskDriverEvent, parseDriverTaskId } from "./task-driver.js";
import type { WakeTaskTransitionHooks } from "./task-wake.js";
import { type ArchivedMessage, createEventTurnRunner } from "./turn-run.js";

function isNoRunningTaskQueueError(err: unknown): boolean {
	return err instanceof Error && err.message === "No task is currently running.";
}

export interface TurnHandlerOptions {
	paths: BootstrapPaths;
	/** Override the `/stop` watchdog's grace window (tests use a short one). */
	stopForceEndGraceMs?: number;
	/** Test-only fault seams for the atomic structured-wake task transition. */
	wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
}

/**
 * Everything the turn handler needs from `createRuntimeContext`'s scope (review 2026-08-30):
 * pulled out so the handler's dependencies are a reviewable, typed list instead of "however many
 * closures happen to be in scope" in an 850-line inline object literal. The four `get*`/`is*`
 * accessors exist only for state this function's own scope assigns *after* the handler is built
 * (`durableDispatch`, `executor`, `taskDriver`) or mutates later (`shuttingDown`) — a handler
 * method only ever runs long after all of them are set, but a plain value captured at
 * construction time would freeze a stale snapshot instead of observing the real one.
 */
export interface TurnHandlerDeps {
	options: TurnHandlerOptions;
	store: ChannelStore;
	channelRunners: Map<string, AgentRunner>;
	sessionResetChains: Map<string, Promise<void>>;
	activeTasks: Set<Promise<void>>;
	stopWatchdogs: Set<string>;
	channelIndex: ChannelIndex;
	archiveIncomingMessage: (channelId: string, message: ArchivedMessage, contextLabel: string) => Promise<void>;
	getRunner: (channelId: string) => AgentRunner;
	cliVersion: string;
	startedAt: number;
	isShuttingDown: () => boolean;
	getDurableDispatch: () => DurableDispatchService | undefined;
	getJobs: () => JobRuntime;
	getRuns: () => SubAgentRuntime;
	getTaskDriver: () => { nudge?(): void };
}

export function createTurnHandler(deps: TurnHandlerDeps): DingTalkHandler {
	const {
		options,
		store,
		channelRunners,
		sessionResetChains,
		activeTasks,
		stopWatchdogs,
		channelIndex,
		archiveIncomingMessage,
		getRunner,
		cliVersion,
		startedAt,
		isShuttingDown,
		getDurableDispatch,
		getJobs,
		getRuns,
		getTaskDriver,
	} = deps;

	const runEventTurn = createEventTurnRunner({
		options,
		store,
		activeTasks,
		archiveIncomingMessage,
		getRunner,
		isShuttingDown,
		getDurableDispatch,
		getJobs,
		getRuns,
		getTaskDriver,
		runRuntimeCommand: (event, name, args) => handler.runRuntimeCommand(event, name, args),
	});

	const handler: DingTalkHandler = {
		isRunning(channelId: string): boolean {
			return channelRunners.get(channelId)?.isBusy() ?? false;
		},

		noteChannelActivity(observation): void {
			if (isShuttingDown()) return;
			channelIndex.note(observation);
		},

		async handleStop(channelId: string, _bot: DingTalkBotPort): Promise<StopOutcome> {
			const runner = channelRunners.get(channelId);
			let pausedTaskId: string | undefined;
			if (runner?.isBusy()) {
				runner.requestStop();
				// Stopping a task step stops the task: otherwise the driver would queue the next step
				// straight away. The step may not be bound to its session yet, so fall back to the text.
				const taskId = runner.getTaskLoop()?.taskId ?? parseDriverTaskId(runner.getTurnStatus().taskText);
				if (taskId) {
					await pauseStoredTask(getChannelDir(options.paths.workspaceDir, channelId), taskId, {
						by: "user",
						reason: "用户 /stop 中止了该任务的当前步骤。",
					});
					pausedTaskId = taskId;
					log.logInfoEvent("tasks.task.paused_on_stop", "Task paused on /stop", {
						channelId: channelId,
						fields: { taskId },
					});
				}
				_bot.discardCard(channelId);
				// Drop queued-but-not-started messages so a burst does not keep
				// running after the user asked to halt; abort the in-flight one.
				const dropped = _bot.clearPendingMessages(channelId);
				if (dropped > 0) {
					log.logInfoEvent("agent.turn.queue_dropped", "Queued messages dropped on /stop", {
						channelId: channelId,
						fields: { count: dropped },
					});
				}
				void runner.abort().catch((err) => {
					log.logWarn("agent.turn.abort_failed", "Turn abort failed", {
						channelId: channelId,
						reason: errorMessage(err),
					});
				});
				void getDurableDispatch()
					?.cancelChannel(channelId)
					.then((canceled) => {
						if (canceled)
							log.logInfoEvent("dispatch.cancel.reset", "Durable dispatch leases reset on /stop", {
								channelId: channelId,
								fields: { count: canceled },
							});
					})
					.catch((err) => {
						log.logWarn("dispatch.cancel.failed", "Durable dispatch lease reset on stop failed", {
							channelId: channelId,
							reason: errorMessage(err),
						});
					});
				log.logInfoEvent("agent.turn.stop_requested", "Stop requested", { channelId: channelId });
				if (!stopWatchdogs.has(channelId)) {
					stopWatchdogs.add(channelId);
					void forceEndStuckTurnAfterStop({
						channelId,
						runner,
						graceMs: options.stopForceEndGraceMs,
						notify: (text) => _bot.sendPlain(channelId, text),
					})
						.catch((err) => {
							log.logWarn("agent.turn.stop_watchdog_failed", "Stop watchdog failed", {
								channelId: channelId,
								reason: errorMessage(err),
							});
						})
						.finally(() => {
							stopWatchdogs.delete(channelId);
						});
				}
			}
			return { pausedTaskId };
		},

		async handleNewSession(event: ChannelEvent, _bot: DingTalkBotPort): Promise<void> {
			if (isShuttingDown()) return;
			const previous = sessionResetChains.get(event.channelId) ?? Promise.resolve();
			const reset = previous
				.catch(() => undefined)
				.then(async () => {
					try {
						const channelDir = ensureChannelDir(options.paths.workspaceDir, event.channelId);
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
								oldRunner.retireForNewSession();
							} catch (error) {
								// The active pointer already names the new session. Retirement is
								// best-effort cleanup and must not misreport the committed reset as failed.
								log.logWarn("agent.session.retire_failed", "Old runner retirement after /new failed", {
									channelId: event.channelId,
									reason: errorMessage(error),
								});
							}
						}
						const dropped = _bot.resetChannelQueue(event.channelId);
						if (dropped > 0) {
							log.logInfoEvent("agent.session.queue_dropped", "Old-session queued messages discarded by /new", {
								channelId: event.channelId,
								fields: { count: dropped },
							});
						}
						await _bot.sendPlain(event.channelId, formatNewSessionReply(result.sessionId));
						void archiveIncomingMessage(
							event.channelId,
							{
								date: new Date().toISOString(),
								ts: event.ts,
								user: event.user,
								userName: event.userName,
								text: event.text,
								isBot: false,
								images: relativeImagePaths(options.paths.workspaceDir, event.channelId, event.images),
							},
							"/new command",
						);
					} catch (error) {
						const message = errorMessage(error);
						log.logWarn("agent.session.create_failed", "Fresh session creation failed", {
							channelId: event.channelId,
							reason: message,
						});
						await _bot.sendPlain(
							event.channelId,
							`新会话创建失败：${message}\n旧会话保持不变，可以重试 \`/new\`。`,
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
			const { channelId } = event;
			return runReportCommand(
				{
					channelId,
					paths: options.paths,
					actor: "dingtalk-command",
					version: cliVersion,
					startedAt,
					peekRunner: () => channelRunners.get(channelId),
					getRunner: () => getRunner(channelId),
					runManager: getRuns().get(channelId),
					runningJobLines: () => getJobs().runningLines(channelId),
					// D4.2: dispose the cached runner so the next access rebuilds it under the new scope.
					// The active-session ref is untouched — same session, new project root.
					onScopeChanged: async () => {
						const runner = channelRunners.get(channelId);
						channelRunners.delete(channelId);
						await runner?.dispose().catch((err) => {
							log.logWarn("runtime.runner.dispose_failed", "Runner dispose after /project failed", {
								channelId: channelId,
								reason: errorMessage(err),
							});
						});
					},
					dispatchTask: async (id) => {
						const channelDir = getChannelDir(options.paths.workspaceDir, channelId);
						const entry = (await readActiveTasks(join(channelDir, "tasks"))).find(
							(candidate) => candidate.id === id,
						);
						if (!entry) return false;
						// A human asking to run a task twice means twice, so this key is deliberately
						// unique per invocation rather than sharing the driver's occurrence key (D1).
						const now = Date.now();
						return (
							(await getDurableDispatch()?.dispatch({
								...createTaskDriverEvent(channelId, entry, now),
								dispatchId: `task:${channelId}:${entry.id}:manual:${new Date(now).toISOString()}`,
							})) ?? false
						);
					},
				},
				name,
				args,
			);
		},

		async handleBusyMessage(
			event: ChannelEvent,
			bot: DingTalkBotPort,
			mode: BusyMessageMode,
			queueText: string,
		): Promise<BusyMessageResult> {
			if (isShuttingDown()) {
				return { kind: "handled" };
			}

			const runner = getRunner(event.channelId);
			const trimmedQueueText = queueText.trim();

			if (!trimmedQueueText) {
				await bot.sendPlain(event.channelId, formatMissingQueueMessage(mode === "followUp" ? "followup" : "steer"));
				return { kind: "handled" };
			}

			// Compaction is maintenance, not user work. A new message cancels it and is
			// kept as a normal queued turn instead of trying to steer an agent loop that
			// is currently disconnected for summarization.
			if (runner.interruptCompaction()) {
				log.logInfoEvent("agent.compaction.interrupted", "Compaction interrupted for a new user message", {
					channelId: event.channelId,
				});
				return { kind: "requeue", text: trimmedQueueText };
			}

			// A task step runs in the task's own session and is muted: a steer here would land in
			// the background task's context and its answer would never reach the user, while the
			// message itself is kept out of the chat session. Run it as the next chat turn instead.
			const taskLoop = runner.getTaskLoop();
			if (taskLoop) {
				await bot.sendPlain(
					event.channelId,
					`后台任务 \`${taskLoop.taskId}\` 正在执行一步，你的消息会在这一步结束后处理；要给该任务补充指示，用 \`/tasks steer ${taskLoop.taskId} <内容>\`。`,
				);
				log.logEvent("info", "agent.turn.followup_queued", "Message deferred past a task step", {
					ctx: { channelId: event.channelId, userName: event.userName },
					fields: { messageLength: trimmedQueueText.length, taskId: taskLoop.taskId },
				});
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
				await runner.queueSteer(trimmedQueueText, event.userName, event.images);

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
						images: relativeImagePaths(options.paths.workspaceDir, event.channelId, event.images),
					},
					`${mode} message`,
				);

				await bot.sendPlain(event.channelId, formatSteerQueued(!event.text.trim().startsWith("/")));
				log.logEvent("info", "agent.turn.steer_queued", "Steer queued", {
					ctx: { channelId: event.channelId, userName: event.userName },
					fields: { messageLength: trimmedQueueText.length },
				});
				return { kind: "handled" };
			} catch (err) {
				const errMsg = errorMessage(err);
				if (isNoRunningTaskQueueError(err)) {
					log.logInfoEvent("agent.turn.requeued", "Busy window closed; message requeued as a normal turn", {
						channelId: event.channelId,
						fields: { mode },
					});
					return { kind: "requeue", text: trimmedQueueText };
				}
				log.logWarn("agent.turn.queue_failed", "Busy message queueing failed", {
					channelId: event.channelId,
					reason: errMsg,
					fields: { mode },
				});
				await bot.sendPlain(
					event.channelId,
					`这条消息没能排进当前回合：${errMsg}\n等当前回合结束后重发，或用 \`/followup <消息>\` 排到它之后。`,
				);
				return { kind: "handled" };
			}
		},

		persistInboundImage: (channelId, image) => persistInboundImage(options.paths.workspaceDir, channelId, image),

		handleEvent: runEventTurn,

		reserveEvent(event: ChannelEvent): void {
			// Must stay synchronous: runs before the queued handler is awaited, so busy state shows up at once.
			getRunner(event.channelId).beginTurn(event.text);
		},
	};
	return handler;
}
