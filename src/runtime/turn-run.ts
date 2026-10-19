/**
 * One turn of the daemon's per-channel pipeline (`DingTalkHandler.handleEvent`): dispatch admission,
 * built-in commands, wake verification, the agent run — as a task step when the wake is one — and
 * the settle-and-release epilogue that runs whatever happens.
 */
import type { AgentRunner } from "../agent/types.js";
import type { BootstrapPaths } from "../app/home.js";
import { type ChannelContext, muteChannelContext } from "../channel/channel-context.js";
import type { ChannelEvent } from "../channel/channel-event.js";
import type { ChannelStore } from "../channel/store.js";
import {
	BUILT_IN_COMMANDS,
	formatUnknownCommandMessage,
	isRunnerBuiltInCommand,
	parseBuiltInCommand,
	type RuntimeCommandName,
	renderBuiltInHelp,
	slashCommandName,
} from "../commands/catalog.js";
import { createDingTalkContext } from "../dingtalk/delivery.js";
import type { DingTalkBotPort } from "../dingtalk/handler.js";
import { formatUnavailableDotReply, formatUnboundChannelReply } from "../dot/commands.js";
import { getDotDir } from "../dot/paths.js";
import type { JobRuntime } from "../jobs/manager.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import type { SubAgentRuntime } from "../subagents/run-registry.js";
import { buildTaskStepBrief } from "../tasks/brief.js";
import { consumeTaskNotice } from "../tasks/steer.js";
import type { ChannelResolution } from "./dot-runtime.js";
import type { DurableDispatchService } from "./durable-dispatch.js";
import { relativeImagePaths } from "./inbound-images.js";
import { parseDriverTaskId } from "./task-driver.js";
import type { WakeTaskTransitionHooks } from "./task-wake.js";
import { claimVerifiedWake } from "./task-wake.js";
import { canAbsorbWake, isCoalescableWake, MAX_COALESCED_WAKES, mergeCompletionWakes } from "./wake-coalescing.js";

/**
 * The `runRuntimeCommand` names usable on the idle-turn path — every `BUILT_IN_COMMANDS` entry
 * *not* marked `runnerHandled`, i.e. every stateless report. `context` is the one deliberate
 * exception even though it isn't runner-handled while busy (see the busy-path switch in
 * `dingtalk/bot.ts`): idle answers it through the runner's ChannelContext-aware command path
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
 * A wake from an in-process producer rather than a person. Every production producer goes through
 * durable dispatch (so carries a `dispatchId`) and stamps its `dot`; DingTalk inbound parsing sets
 * neither. `isEvent` is the transport's own flag for its synthetic queue path.
 */
export function isSyntheticEvent(event: ChannelEvent, isEvent?: boolean): boolean {
	return Boolean(isEvent) || event.dispatchId !== undefined || event.dot !== undefined;
}

/** One message or wake, written to the message archive (see `ChannelStore.logMessage`). */
export interface ArchivedMessage {
	date: string;
	ts: string;
	user: string;
	userName?: string;
	text: string;
	isBot: boolean;
	deliveryMode?: "steer" | "followUp";
	skipContextSync?: boolean;
	images?: string[];
}

export interface EventTurnDeps {
	options: {
		paths: BootstrapPaths;
		/** Test-only fault seams for the atomic structured-wake task transition. */
		wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
	};
	store: ChannelStore;
	activeTasks: Set<Promise<void>>;
	archiveIncomingMessage: (channelId: string, message: ArchivedMessage, contextLabel: string) => Promise<void>;
	/** The channel's runner; `undefined` when the channel is not bound to an available dot (no runner is built). */
	getRunner: (channelId: string) => AgentRunner | undefined;
	resolveChannel: (channelId: string) => ChannelResolution;
	/** Events whose `reserveEvent` began a turn: a turn rejected at admission releases exactly these. */
	reservedTurns: WeakSet<ChannelEvent>;
	isShuttingDown: () => boolean;
	getDurableDispatch: () => DurableDispatchService | undefined;
	getJobs: () => JobRuntime;
	getRuns: () => SubAgentRuntime;
	getTaskDriver: () => { nudge?(): void };
	/** The handler's `runRuntimeCommand`, for stateless reports typed on an idle channel. */
	runRuntimeCommand: (event: ChannelEvent, name: RuntimeCommandName, args: string) => Promise<string>;
}

/**
 * The turn pipeline behind `DingTalkHandler.handleEvent`: admit the dispatch, run commands or the
 * agent (as a task step when the wake is one), and always settle the dispatch and release the turn.
 */
export function createEventTurnRunner(
	deps: EventTurnDeps,
): (inboundEvent: ChannelEvent, bot: DingTalkBotPort, isEvent?: boolean) => Promise<void> {
	const {
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
		const { dot, dotDir } = runner.conversation;
		// Admission already refused a wake for another dot (spec 058, D7); a task step bound to the
		// wrong dot's session would run a task this runner does not own, so check once more.
		if (event.dot !== dot) {
			log.logWarn("taskdriver.step.dot_mismatch", "Task step refused: wake is not for this runner's dot", {
				channelId: event.channelId,
				fields: { taskId, eventDot: event.dot, runnerDot: dot },
			});
			return undefined;
		}
		try {
			const brief = await buildTaskStepBrief({ dotDir, taskId });
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
	const finishTaskStep = async (
		runner: AgentRunner,
		channelId: string,
		taskId: string,
		bot: DingTalkBotPort,
	): Promise<void> => {
		try {
			const notice = await consumeTaskNotice(runner.conversation.dotDir, taskId);
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
		await runner.bindChatSession();
	};

	/** Mutable state of one turn, shared by the steps below (the wake may be merged or rewritten mid-turn). */
	interface TurnState {
		event: ChannelEvent;
		baseCtx: ChannelContext | undefined;
		structuredWakeFinalized: boolean;
		/** Other completion wakes folded into this turn; finished together with this one. */
		absorbedDispatchIds: string[];
		/** Only an agent run that returns without aborting or erroring can acknowledge merged notifications. */
		mergedWakesHandled: boolean;
	}

	/**
	 * Dispatch admission: refuse a stale redelivery of a wake an earlier turn already handled (the
	 * turn is released), and fold other pending completion wakes into this one. `undefined` = skip.
	 */
	const admitTurn = async (inboundEvent: ChannelEvent, runner: AgentRunner): Promise<TurnState | undefined> => {
		let event = inboundEvent;
		const durable = getDurableDispatch();
		// Sampled synchronously, before any await: `/stop` after this point cleared the queued closures.
		const stopEpoch = durable?.stopEpoch(inboundEvent.channelId) ?? 0;
		deps.reservedTurns.delete(inboundEvent);
		if (durable && !(await durable.markStarted(event.dispatchId))) {
			// A stale delivery of a wake an earlier turn already absorbed and handled.
			runner.endTurn();
			return undefined;
		}
		const structuredWakeFinalized = event.internalWake === undefined;
		let absorbedDispatchIds: string[] = [];
		if (durable && event.dispatchId && isCoalescableWake(event)) {
			const primary = event;
			const absorbed = await durable
				.absorbPending(
					event.channelId,
					event.dispatchId,
					(candidate) => canAbsorbWake(primary, candidate),
					MAX_COALESCED_WAKES - 1,
					stopEpoch,
				)
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
		return { event, baseCtx: undefined, structuredWakeFinalized, absorbedDispatchIds, mergedWakesHandled: false };
	};

	/** A built-in slash command typed on an idle channel: stateless reports here, session commands on the runner. */
	const runBuiltinCommand = async (
		turn: TurnState,
		builtInCommand: NonNullable<ReturnType<typeof parseBuiltInCommand>>,
		runner: AgentRunner,
		ctx: ChannelContext,
		bot: DingTalkBotPort,
	): Promise<void> => {
		const { event } = turn;
		const commandStartedAt = Date.now();
		const logCtx = { channelId: event.channelId, userName: event.userName };
		log.logEvent("info", "runtime.command.started", "Executing command", {
			ctx: logCtx,
			fields: { command: builtInCommand.name },
		});
		try {
			if (isIdleRuntimeCommandName(builtInCommand.name)) {
				const response = await deps.runRuntimeCommand(event, builtInCommand.name, builtInCommand.args);
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
	};

	/**
	 * A completion wake for a task's job or delegation: verified against the resource's own record
	 * before it may reopen the task (see `claimVerifiedWake`). Plain "belongs to task" text in a
	 * message never counts — only the producer-created `internalWake` envelope. Returns whether the
	 * turn should still run.
	 */
	const verifyInternalWake = async (
		turn: TurnState,
		runner: AgentRunner,
		internalWake: NonNullable<ChannelEvent["internalWake"]>,
	) => {
		const { event } = turn;
		const { kind, resourceId, taskId: wakeTaskId } = internalWake;
		const { dot, dotDir } = runner.conversation;
		const claimed = await claimVerifiedWake(
			event,
			dotDir,
			kind === "job" ? getJobs().get(dot) : getRuns().get(dot),
			options.wakeTransitionHooks?.[kind],
		);
		if (!claimed) {
			log.logWarn("dispatch.wake.unverified", "Unverifiable wake ignored", {
				channelId: event.channelId,
				fields: { kind, resourceId, taskId: wakeTaskId },
			});
			turn.structuredWakeFinalized = true;
			return false;
		}
		await claimed.finish();
		turn.structuredWakeFinalized = true;
		// Drop without a turn only when something else is still driving this task (a sibling
		// wake in the same fan-out already reopened it); in every other case nobody else will
		// look at this result, so it still reaches a normal turn.
		return claimed.activated || !claimed.taskStillDriven;
	};

	/** The turn proper: archive, route commands, verify wakes, then run the agent (as a task step if one). */
	const executeTurn = async (
		turn: TurnState,
		runner: AgentRunner,
		bot: DingTalkBotPort,
		backgroundOnly: boolean,
	): Promise<void> => {
		const { event } = turn;
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
				images: relativeImagePaths(runner.conversation.dotDir, event.images),
			},
			"user message",
		);

		// Background wakes deliver their result, not their process: no progress card, no
		// thinking stream, nothing to clean up when a check-in ends `[SILENT]`.
		// Awaited completions deliver their result too, without opening another progress card.
		// Spec 051, D3: a task-driver dispatch runs as a *task step* — in the task cycle's
		// own session, with a brief instead of the wake text, and silent unless the step
		// asked for a notify. Everything below (busy state, /stop, delivery) is unchanged;
		// only which session the turn is bound to, and what reaches the channel, differ.
		let baseCtx = createDingTalkContext(event, bot, store, backgroundOnly ? "none" : undefined);
		turn.baseCtx = baseCtx;
		let ctx = baseCtx;

		if (builtInCommand) {
			await runBuiltinCommand(turn, builtInCommand, runner, ctx, bot);
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
			fields: { messageLength: event.text.length, source: backgroundOnly ? "event" : "message" },
		});
		if (event.internalWake && !(await verifyInternalWake(turn, runner, event.internalWake))) return;
		// Verified job/run wakes that activate a task are task steps too. Verification must happen
		// first: routing directly from user-controlled wake text would grant task-only tools.
		const taskStep = await prepareTaskStep(turn.event, runner);
		if (taskStep) {
			await baseCtx.close();
			turn.event = { ...turn.event, text: taskStep.brief };
			baseCtx = createDingTalkContext(turn.event, bot, store, "none");
			turn.baseCtx = baseCtx;
			ctx = muteChannelContext(baseCtx);
		}
		if (!backgroundOnly && !taskStep) ctx.primeCard(3500);
		const result = await runner.run(ctx, store);
		turn.mergedWakesHandled = result.stopReason !== "aborted" && result.stopReason !== "error";
		if (taskStep) await finishTaskStep(runner, turn.event.channelId, taskStep.taskId, bot);

		if (result.stopReason === "aborted" && runner.getTurnStatus().stopRequested) {
			log.logInfoEvent("agent.turn.stopped", "Turn stopped", { channelId: turn.event.channelId });
		}
	};

	/** Always runs: close delivery, settle the dispatch records, release the turn, nudge the task driver. */
	const finishTurn = async (turn: TurnState, runner: AgentRunner): Promise<void> => {
		const { event } = turn;
		await turn.baseCtx?.close().catch((error: unknown) => {
			log.logWarn("delivery.close.failed", "Delivery close failed", {
				channelId: event.channelId,
				reason: errorMessage(error),
			});
		});
		if (turn.structuredWakeFinalized) await getDurableDispatch()?.markCompleted(event.dispatchId);
		else await getDurableDispatch()?.markRetryable(event.dispatchId);
		// A stopped turn has not finished handling its merged notifications. Release their
		// claims even if /stop's asynchronous cancelChannel reset raced admission or failed.
		const stopped = !turn.mergedWakesHandled || runner.getTurnStatus().stopRequested;
		for (const absorbedId of turn.absorbedDispatchIds) {
			if (stopped) await getDurableDispatch()?.markRetryable(absorbedId);
			else await getDurableDispatch()?.markCompleted(absorbedId);
		}
		runner.endTurn();
		// A finished turn may have written task files; rescan now so `outcome: continue`
		// queues the next step immediately instead of waiting out the current sleep.
		getTaskDriver().nudge?.();
	};

	/**
	 * A task-bound wake dropped at admission because its channel left the wake's dot while it was
	 * queued. No turn runs, but the business side settles exactly as when the producer suppresses
	 * the wake itself: the owner verifies and claims it and the task's `work` ticket is redeemed, so
	 * the task resumes as soon as its channel is bound back instead of waiting out the backstop.
	 */
	const settleDroppedTaskWake = async (event: ChannelEvent): Promise<void> => {
		const wake = event.internalWake;
		if (!wake || !event.dot) return;
		try {
			const owner = wake.kind === "job" ? getJobs().get(event.dot) : getRuns().get(event.dot);
			const claimed = await claimVerifiedWake(event, getDotDir(options.paths.workspaceDir, event.dot), owner);
			await claimed?.finish();
		} catch (error) {
			log.logWarn("dispatch.wake.redeem_failed", "Work ticket redeem for a dropped wake failed", {
				channelId: event.channelId,
				reason: errorMessage(error),
				fields: { dispatchId: event.dispatchId, taskId: wake.taskId },
			});
		}
	};

	/** Release a turn `reserveEvent` began for an event that admission then refused. */
	const releaseReservation = (event: ChannelEvent): void => {
		if (!deps.reservedTurns.delete(event)) return;
		getRunner(event.channelId)?.endTurn();
	};

	/**
	 * A human message on a channel with no usable dot (D4): nothing is archived, no runner is built
	 * and no model is called. `/help` still answers (and `/dot`, before this); everything else gets
	 * the one reason and the next step.
	 */
	const replyWithoutDot = async (
		event: ChannelEvent,
		resolution: Exclude<ChannelResolution, { kind: "bound" }>,
		bot: DingTalkBotPort,
	): Promise<void> => {
		const command = parseBuiltInCommand(event.text);
		if (command?.name === "help") {
			await bot.sendPlain(event.channelId, renderBuiltInHelp(command.args), { title: "/help", markdown: true });
			return;
		}
		await bot.sendPlain(
			event.channelId,
			resolution.kind === "unbound" ? formatUnboundChannelReply() : formatUnavailableDotReply(resolution.dot),
			{ markdown: true },
		);
	};

	const runDotCommand = async (event: ChannelEvent, args: string, bot: DingTalkBotPort): Promise<void> => {
		const logCtx = { channelId: event.channelId, userName: event.userName };
		log.logEvent("info", "runtime.command.started", "Executing command", { ctx: logCtx, fields: { command: "dot" } });
		const response = await deps.runRuntimeCommand(event, "dot", args);
		const delivered = await bot.sendPlain(event.channelId, response, { title: "/dot", markdown: true });
		if (!delivered) {
			log.logWarn("delivery.command_reply.failed", "Command reply delivery failed", {
				channelId: event.channelId,
				fields: { command: "dot", chars: response.length },
			});
		}
	};

	const runEventTurn = async (inboundEvent: ChannelEvent, bot: DingTalkBotPort, isEvent?: boolean): Promise<void> => {
		if (isShuttingDown()) {
			log.logInfoEvent("runtime.shutdown.event_ignored", "Event ignored during shutdown", {
				channelId: inboundEvent.channelId,
			});
			return;
		}

		const resolution = deps.resolveChannel(inboundEvent.channelId);
		if (isSyntheticEvent(inboundEvent, isEvent)) {
			// D7's authoritative check: a wake is admitted only while its channel is still bound to the
			// dot it was produced for. Covers wakes queued before a restart, a rebind while queued, and
			// records left from before the migration (which carry no dot at all).
			if (!inboundEvent.dot || resolution.kind !== "bound" || resolution.conversation.dot !== inboundEvent.dot) {
				log.logInfoEvent("dispatch.wake.dot_mismatch", "Wake dropped: channel not bound to the wake's dot", {
					channelId: inboundEvent.channelId,
					fields: {
						dispatchId: inboundEvent.dispatchId,
						wakeDot: inboundEvent.dot,
						boundDot:
							resolution.kind === "unbound"
								? undefined
								: resolution.kind === "bound"
									? resolution.conversation.dot
									: resolution.dot,
					},
				});
				releaseReservation(inboundEvent);
				await settleDroppedTaskWake(inboundEvent);
				await getDurableDispatch()?.markCompleted(inboundEvent.dispatchId);
				return;
			}
		} else {
			// `/dot` runs outside any turn, bound or not: nothing is archived and no runner is built,
			// so `/dot bind` sees this channel idle and the next queued message already resolves
			// against the new binding (D5).
			const command = parseBuiltInCommand(inboundEvent.text);
			if (command?.name === "dot") {
				releaseReservation(inboundEvent);
				await runDotCommand(inboundEvent, command.args, bot);
				return;
			}
			if (resolution.kind !== "bound") {
				await replyWithoutDot(inboundEvent, resolution, bot);
				return;
			}
		}

		const runner = getRunner(inboundEvent.channelId);
		if (!runner) return;
		const turn = await admitTurn(inboundEvent, runner);
		if (!turn) return;
		const task = (async () => {
			try {
				await executeTurn(turn, runner, bot, Boolean(isEvent));
			} catch (err) {
				log.logEvent("error", "agent.turn.failed", "Turn failed", {
					ctx: { channelId: turn.event.channelId, userName: turn.event.userName },
					fields: { error: errorMessage(err) },
				});
			} finally {
				await finishTurn(turn, runner);
			}
		})();

		activeTasks.add(task);
		try {
			await task;
		} finally {
			activeTasks.delete(task);
		}
	};

	return runEventTurn;
}
