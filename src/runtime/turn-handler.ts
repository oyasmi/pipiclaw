/**
 * The daemon's per-channel turn handler: what happens when the DingTalk transport hands the runtime
 * a message, `/stop`, `/new`, a busy-turn message, or a synthetic wake. Wired together (and handed
 * its collaborators) by `bootstrap.ts`.
 */
import { mkdir, writeFile } from "fs/promises";
import { join, relative } from "path";
import type { AgentRunner } from "../agent/types.js";
import type { BootstrapPaths } from "../app/home.js";
import { createFreshActiveSession } from "../channel/active-session-store.js";
import { type ChannelContext, muteChannelContext } from "../channel/channel-context.js";
import type { ChannelEvent, InboundImage } from "../channel/channel-event.js";
import type { ChannelIndex } from "../channel/channel-index.js";
import { ensureChannelDir, getChannelDir } from "../channel/channel-paths.js";
import { resolveProjectScope } from "../channel/project-scope-store.js";
import type { ChannelStore } from "../channel/store.js";
import {
	BUILT_IN_COMMANDS,
	formatMissingQueueMessage,
	formatNewSessionReply,
	formatSteerQueued,
	formatUnknownCommandMessage,
	isRunnerBuiltInCommand,
	parseBuiltInCommand,
	type RuntimeCommandName,
	slashCommandName,
} from "../commands/catalog.js";
import { runReportCommand } from "../commands/router.js";
import type { BusyMessageMode } from "../dingtalk/config.js";
import { createDingTalkContext } from "../dingtalk/delivery.js";
import type { BusyMessageResult, DingTalkBotPort, DingTalkHandler, StopOutcome } from "../dingtalk/handler.js";
import { extensionForMimeType } from "../dingtalk/inbound-media.js";
import type { JobRuntime } from "../jobs/manager.js";
import * as log from "../log.js";
import { loadSecurityConfigWithDiagnostics } from "../security/config.js";
import { resolveProjectAccessPolicy } from "../security/project-scope.js";
import { localStampForFilename } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import type { SubAgentRuntime } from "../subagents/runs.js";
import { buildTaskStepBrief } from "../tasks/brief.js";
import { readActiveTasks } from "../tasks/contract.js";
import { consumeTaskNotice } from "../tasks/steer.js";
import { pauseTask as pauseStoredTask } from "../tasks/store.js";
import type { DurableDispatchService } from "./durable-dispatch.js";
import { forceEndStuckTurnAfterStop } from "./stop-watchdog.js";
import { createTaskDriverEvent, parseDriverTaskId } from "./task-driver.js";
import type { WakeTaskTransitionHooks } from "./task-wake.js";
import { claimVerifiedWake } from "./task-wake.js";
import { isCoalescableWake, MAX_COALESCED_WAKES, mergeCompletionWakes } from "./wake-coalescing.js";

function isNoRunningTaskQueueError(err: unknown): boolean {
	return err instanceof Error && err.message === "No task is currently running.";
}

/**
 * Absolute `InboundImage.path`s → paths relative to the channel directory, for
 * `LoggedMessage.images` (spec 049). `log.jsonl` already stores everything else channel-relative
 * (it lives inside the channel directory itself); an absolute path there would be dead on any
 * machine other than the one that wrote it, and `~/.pipiclaw` itself can move between backup and
 * restore.
 */
function relativeImagePaths(workspaceDir: string, channelId: string, images: InboundImage[] | undefined): string[] {
	if (!images || images.length === 0) return [];
	const channelDir = getChannelDir(workspaceDir, channelId);
	return images.map((image) => relative(channelDir, image.path));
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
	archiveIncomingMessage: (
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
			images?: string[];
		},
		contextLabel: string,
	) => Promise<void>;
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

	/**
	 * Turn a `[TASK_DRIVER:<id>]` dispatch into a task loop step: bind the runner to the task
	 * cycle's own session and replace the wake text with the step brief. Returns `undefined` for
	 * every other event, which then follows the unchanged chat path.
	 *
	 * Binding failures fall back to the chat path rather than dropping the wake — a task that
	 * cannot open its session should still be visible, not silently skipped.
	 */
	const prepareTaskStep = async (
		event: ChannelEvent,
		runner: AgentRunner,
	): Promise<{ taskId: string; brief: string } | undefined> => {
		const taskId = parseDriverTaskId(event.text) ?? event.internalWake?.taskId;
		if (!taskId) return undefined;
		const channelDir = ensureChannelDir(options.paths.workspaceDir, event.channelId);
		try {
			const brief = await buildTaskStepBrief({ channelDir, taskId });
			if (!brief) return undefined;
			await runner.bindTaskSession(taskId);
			return { taskId, brief };
		} catch (error) {
			log.logWarn("taskdriver.step.start_failed", "Task step start failed", {
				channelId: event.channelId,
				reason: errorMessage(error),
				fields: { taskId },
			});
			return undefined;
		}
	};

	/** Deliver whatever the step asked to say, then hand the runner back to the chat session. */
	const finishTaskStep = async (channelId: string, taskId: string, bot: DingTalkBotPort): Promise<void> => {
		const channelDir = ensureChannelDir(options.paths.workspaceDir, channelId);
		try {
			const notice = await consumeTaskNotice(channelDir, taskId);
			if (notice) {
				// runner.run closes its per-turn delivery context before returning. Sending through that
				// closed context silently dropped successful task_step_end notifications (T-run-01).
				const delivered = await bot.sendPlain(channelId, notice);
				if (delivered) await store.logBotResponse(channelId, notice, Date.now().toString());
				else
					log.logWarn("taskdriver.notice.delivery_failed", "Task notice delivery failed", {
						channelId: channelId,
						fields: { taskId },
					});
			}
		} catch (error) {
			log.logWarn("taskdriver.notice.delivery_failed", "Task notice delivery failed", {
				channelId: channelId,
				reason: errorMessage(error),
				fields: { taskId },
			});
		}
		await getRunner(channelId).bindChatSession();
	};

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

		/**
		 * Persist one downloaded inbound image under the channel's `inbox/` (spec 049). Bootstrap
		 * owns this, not the transport, because it holds the workspace root; see the doc comment
		 * on `DingTalkHandler.persistInboundImage` for the full contract (`mimeType: null` case
		 * included).
		 */
		async persistInboundImage(
			channelId: string,
			image: { data: Buffer; mimeType: string | null },
		): Promise<InboundImage | null> {
			try {
				const dir = join(getChannelDir(options.paths.workspaceDir, channelId), "inbox");
				await mkdir(dir, { recursive: true });
				const extension = extensionForMimeType(image.mimeType);
				const path = join(
					dir,
					`image-${localStampForFilename()}-${Math.random().toString(36).slice(2, 8)}.${extension}`,
				);
				await writeFile(path, image.data, { mode: 0o600 });
				return {
					path,
					mimeType: image.mimeType ?? "application/octet-stream",
					byteSize: image.data.byteLength,
					...(image.mimeType === null ? { unsupportedFormat: true } : {}),
				};
			} catch (err) {
				log.logWarn("dingtalk.media.persist_failed", "Inbound image persist failed", {
					channelId: channelId,
					reason: errorMessage(err),
				});
				return null;
			}
		},

		reserveEvent(event: ChannelEvent): void {
			// Must stay synchronous: runs before the queued handler is awaited, so busy state shows up at once.
			getRunner(event.channelId).beginTurn(event.text);
		},

		async handleEvent(inboundEvent: ChannelEvent, bot: DingTalkBotPort, _isEvent?: boolean): Promise<void> {
			let event = inboundEvent;
			if (isShuttingDown()) {
				log.logInfoEvent("runtime.shutdown.event_ignored", "Event ignored during shutdown", {
					channelId: event.channelId,
				});
				return;
			}

			const runner = getRunner(event.channelId);
			const durable = getDurableDispatch();
			if (durable && !(await durable.markStarted(event.dispatchId))) {
				// A stale delivery of a wake an earlier turn already absorbed and handled.
				runner.endTurn();
				return;
			}
			let structuredWakeFinalized = event.internalWake === undefined;
			/** Other completion wakes folded into this turn; finished together with this one. */
			let absorbedDispatchIds: string[] = [];
			if (durable && event.dispatchId && isCoalescableWake(event)) {
				const absorbed = await durable
					.absorbPending(event.channelId, event.dispatchId, isCoalescableWake, MAX_COALESCED_WAKES - 1)
					.catch((error: unknown) => {
						log.logWarn("dispatch.wake.absorb_failed", "Wake coalescing failed", {
							channelId: event.channelId,
							reason: errorMessage(error),
						});
						return [] as ChannelEvent[];
					});
				if (absorbed.length > 0) {
					event = mergeCompletionWakes(event, absorbed);
					absorbedDispatchIds = absorbed.flatMap((absorbedEvent) =>
						absorbedEvent.dispatchId ? [absorbedEvent.dispatchId] : [],
					);
					log.logInfoEvent("dispatch.wake.coalesced", "Completion wakes coalesced", {
						channelId: event.channelId,
						fields: { primary: event.dispatchId, absorbed: absorbedDispatchIds.length },
					});
				}
			}
			const task = (async () => {
				let baseCtx: ChannelContext | undefined;
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
							images: relativeImagePaths(options.paths.workspaceDir, event.channelId, event.images),
						},
						"user message",
					);

					// Background wakes deliver their result, not their process: no progress card, no
					// thinking stream, nothing to clean up when a check-in ends `[SILENT]`.
					// Awaited completions deliver their result too, without opening another progress card.
					const backgroundOnly = Boolean(_isEvent);
					// Spec 051, D3: a task-driver dispatch runs as a *task step* — in the task cycle's
					// own session, with a brief instead of the wake text, and silent unless the step
					// asked for a notify. Everything below (busy state, /stop, delivery) is unchanged;
					// only which session the turn is bound to, and what reaches the channel, differ.
					let taskStep: { taskId: string; brief: string } | undefined;
					baseCtx = createDingTalkContext(event, bot, store, backgroundOnly ? "none" : undefined);
					let ctx = baseCtx;

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
									log.logWarn("delivery.command_reply.failed", "Command reply delivery failed", {
										channelId: event.channelId,
										fields: { command: builtInCommand.name, chars: response.length },
									});
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
					// A completion wake for a task's job or delegation: verified against the resource's own
					// record before it may reopen the task (see `claimVerifiedWake`). Plain "belongs to task"
					// text in a message never counts — only the producer-created `internalWake` envelope.
					if (event.internalWake) {
						const { kind, resourceId, taskId: wakeTaskId } = event.internalWake;
						const claimed = await claimVerifiedWake(
							event,
							options.paths.workspaceDir,
							kind === "job" ? getJobs().get(event.channelId) : getRuns().get(event.channelId),
							options.wakeTransitionHooks?.[kind],
						);
						if (!claimed) {
							log.logWarn("dispatch.wake.unverified", "Unverifiable wake ignored", {
								channelId: event.channelId,
								fields: { kind, resourceId, taskId: wakeTaskId },
							});
							structuredWakeFinalized = true;
							return;
						}
						await claimed.finish();
						structuredWakeFinalized = true;
						// Drop without a turn only when something else is still driving this task (a sibling
						// wake in the same fan-out already reopened it); in every other case nobody else will
						// look at this result, so it still reaches a normal turn.
						if (!claimed.activated && claimed.taskStillDriven) return;
					}
					// Verified job/run wakes that activate a task are task steps too. Verification must happen
					// first: routing directly from user-controlled wake text would grant task-only tools.
					taskStep = await prepareTaskStep(event, runner);
					if (taskStep) {
						await baseCtx.close();
						event = { ...event, text: taskStep.brief };
						baseCtx = createDingTalkContext(event, bot, store, "none");
						ctx = muteChannelContext(baseCtx);
					}
					if (!backgroundOnly && !taskStep) ctx.primeCard(1500);
					const result = await runner.run(ctx, store);
					if (taskStep) await finishTaskStep(event.channelId, taskStep.taskId, bot);

					if (result.stopReason === "aborted" && runner.getTurnStatus().stopRequested) {
						log.logInfoEvent("agent.turn.stopped", "Turn stopped", { channelId: event.channelId });
					}
				} catch (err) {
					log.logEvent("error", "agent.turn.failed", "Turn failed", {
						ctx: { channelId: event.channelId, userName: event.userName },
						fields: { error: errorMessage(err) },
					});
				} finally {
					await baseCtx?.close().catch((error: unknown) => {
						log.logWarn("delivery.close.failed", "Delivery close failed", {
							channelId: event.channelId,
							reason: errorMessage(error),
						});
					});
					if (structuredWakeFinalized) await getDurableDispatch()?.markCompleted(event.dispatchId);
					else await getDurableDispatch()?.markRetryable(event.dispatchId);
					// Absorbed wakes are chat-level only (no structured claim), so the turn finishing is
					// what finalizes them — exactly as it would have for each on its own.
					for (const absorbedId of absorbedDispatchIds) await getDurableDispatch()?.markCompleted(absorbedId);
					runner.endTurn();
					// A finished turn may have written task files; rescan now so `outcome: continue`
					// queues the next step immediately instead of waiting out the current sleep.
					getTaskDriver().nudge?.();
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
	return handler;
}
