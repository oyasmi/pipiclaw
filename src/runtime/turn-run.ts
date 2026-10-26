/**
 * One turn of the daemon's per-channel pipeline (what a channel queue runs for each item): dispatch
 * admission, built-in commands, wake verification, the agent run — as a task step when the wake is
 * one — and the settle-and-release epilogue that runs whatever happens.
 */
import type { AgentRunner } from "../agent/types.js";
import type { BootstrapPaths } from "../app/home.js";
import type { ChannelContext, TurnOutcome } from "../channel/channel-context.js";
import { type ChannelEvent, senderOf, type WakeEvent } from "../channel/channel-event.js";
import type { ChannelStore } from "../channel/store.js";
import type { Transport, TurnInfo } from "../channel/transport.js";
import {
	BUILT_IN_COMMANDS,
	formatUnknownCommandMessage,
	isRunnerBuiltInCommand,
	parseBuiltInCommand,
	type RuntimeCommandName,
	renderBuiltInHelp,
	slashCommandName,
} from "../commands/catalog.js";
import { formatNoDeskReply } from "../desk/commands.js";
import { getDeskDir } from "../desk/paths.js";
import type { JobRuntime } from "../jobs/manager.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import type { SubAgentRuntime } from "../subagents/run-registry.js";
import { buildTaskStepBrief } from "../tasks/brief.js";
import { consumeTaskNotice } from "../tasks/steer.js";
import { createEmptyUsageTotals } from "../usage/totals.js";
import { admitsSyntheticEvent, type ChannelResolution, resolvedDesk } from "./desk-runtime.js";
import type { DurableDispatchService } from "./durable-dispatch.js";
import { relativeImagePaths } from "./inbound-images.js";
import { parseDriverTaskId } from "./task-driver.js";
import type { WakeTaskTransitionHooks } from "./task-wake.js";
import { claimVerifiedWake } from "./task-wake.js";
import type { TransportRegistry } from "./transports.js";
import { canAbsorbWake, isCoalescableWake, MAX_COALESCED_WAKES, mergeCompletionWakes } from "./wake-coalescing.js";

/**
 * The `runRuntimeCommand` names usable on the idle-turn path — every `BUILT_IN_COMMANDS` entry
 * *not* marked `runnerHandled`, i.e. every stateless report. `context` is the one deliberate
 * exception even though it isn't runner-handled while busy (see the busy-path switch in
 * `ingress.ts`): idle answers it through the runner's command path (it reads the live session)
 * instead, so it is routed like the runner-handled built-ins here and excluded from this
 * stateless-report set.
 */
const IDLE_RUNTIME_COMMAND_NAMES = new Set<string>(
	BUILT_IN_COMMANDS.filter((command) => !command.runnerHandled).map((command) => command.name),
);

function isIdleRuntimeCommandName(name: string): name is Exclude<RuntimeCommandName, "context"> {
	return IDLE_RUNTIME_COMMAND_NAMES.has(name);
}

/** A wake from an in-process producer rather than a person (spec 061, D8: the event's `source`). */
export function isSyntheticEvent(event: ChannelEvent): event is WakeEvent {
	return event.source === "wake";
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

/** A turn's output port plus whether it has been finished, so the epilogue never finishes it twice or not at all. */
interface TrackedOutput {
	ctx: ChannelContext;
	finished: boolean;
}

function trackOutput(ctx: ChannelContext): TrackedOutput {
	const tracked: TrackedOutput = { ctx: undefined as unknown as ChannelContext, finished: false };
	tracked.ctx = {
		emit: (event) => ctx.emit(event),
		finish: (outcome) => {
			tracked.finished = true;
			return ctx.finish(outcome);
		},
	};
	return tracked;
}

/** A task step is silent: its output never reaches the channel (only `task_step_end`'s report does, through `push`). */
function silenceAnswers(ctx: ChannelContext): ChannelContext {
	return { emit: () => undefined, finish: (outcome) => ctx.finish(outcome) };
}

function turnInfoOf(event: ChannelEvent): TurnInfo {
	return {
		channelId: event.channelId,
		...senderOf(event),
		text: event.text,
		...(event.source === "human" && event.context ? { context: event.context } : {}),
		...(event.images ? { images: event.images } : {}),
		...(event.source === "human" && event.ref !== undefined ? { ref: event.ref } : {}),
		ts: event.ts,
	};
}

export interface EventTurnDeps {
	options: {
		paths: BootstrapPaths;
		/** Test-only fault seams for the atomic structured-wake task transition. */
		wakeTransitionHooks?: Partial<Record<"job" | "subagent", WakeTaskTransitionHooks>>;
	};
	transports: TransportRegistry;
	store: ChannelStore;
	activeTasks: Set<Promise<void>>;
	archiveIncomingMessage: (channelId: string, message: ArchivedMessage, contextLabel: string) => Promise<void>;
	/** The channel's runner; `undefined` when the channel is not bound to an available desk (no runner is built). */
	getRunner: (channelId: string) => AgentRunner | undefined;
	isCurrentRunner: (runner: AgentRunner) => boolean;
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
 * The turn pipeline behind a queued item: admit the dispatch, run commands or the agent (as a task
 * step when the wake is one), and always settle the dispatch and release the turn.
 */
export function createEventTurnRunner(deps: EventTurnDeps): (inboundEvent: ChannelEvent) => Promise<void> {
	const {
		options,
		transports,
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
		if (event.source !== "wake") return undefined;
		const taskId = parseDriverTaskId(event.text) ?? event.internalWake?.taskId;
		if (!taskId) return undefined;
		const { desk, deskDir } = runner.conversation;
		// Admission already refused a wake for another desk (spec 058, D7); a task step bound to the
		// wrong desk's session would run a task this runner does not own, so check once more.
		if (event.desk !== desk) {
			log.logWarn("taskdriver.step.desk_mismatch", "Task step refused: wake is not for this runner's desk", {
				channelId: event.channelId,
				fields: { taskId, eventDesk: event.desk, runnerDesk: desk },
			});
			return undefined;
		}
		try {
			const brief = await buildTaskStepBrief({ deskDir, taskId });
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
		transport: Transport,
	): Promise<void> => {
		try {
			const notice = await consumeTaskNotice(runner.conversation.deskDir, taskId);
			if (notice) {
				// runner.run finishes its per-turn output before returning. Sending through that
				// finished output silently dropped successful task_step_end notifications (T-run-01).
				const delivered = await transport.push(channelId, { text: notice });
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
		/** The turn's open output port, once there is one; `finishTurn` settles it if the run did not. */
		output: TrackedOutput | undefined;
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
		const structuredWakeFinalized = event.source !== "wake" || event.internalWake === undefined;
		let absorbedDispatchIds: string[] = [];
		if (durable && event.source === "wake" && event.dispatchId && isCoalescableWake(event)) {
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
					return [] as WakeEvent[];
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
		return { event, output: undefined, structuredWakeFinalized, absorbedDispatchIds, mergedWakesHandled: false };
	};

	/** Say something to the channel in answer to `event`, carrying its reference back to the transport. */
	const replyTo = (
		transport: Transport,
		event: ChannelEvent,
		text: string,
		opts?: { title?: string; markdown?: boolean },
	): Promise<boolean> =>
		transport.push(event.channelId, {
			text,
			...opts,
			...(event.source === "human" && event.ref !== undefined ? { ref: event.ref } : {}),
		});

	/** A built-in slash command typed on an idle channel: stateless reports here, session commands on the runner. */
	const runBuiltinCommand = async (
		turn: TurnState,
		builtInCommand: NonNullable<ReturnType<typeof parseBuiltInCommand>>,
		runner: AgentRunner,
		transport: Transport,
	): Promise<void> => {
		const { event } = turn;
		const commandStartedAt = Date.now();
		const logCtx = { channelId: event.channelId, userName: senderOf(event).userName };
		log.logEvent("info", "runtime.command.started", "Executing command", {
			ctx: logCtx,
			fields: { command: builtInCommand.name },
		});
		try {
			let response: string | undefined;
			if (isIdleRuntimeCommandName(builtInCommand.name)) {
				response = await deps.runRuntimeCommand(event, builtInCommand.name, builtInCommand.args);
			} else if (isRunnerBuiltInCommand(builtInCommand)) {
				response = await runner.handleBuiltinCommand(builtInCommand);
			}
			if (response !== undefined) {
				// Command echoes are control-plane traffic, not conversation: sent, never archived.
				const delivered = await replyTo(transport, event, response, {
					title: `/${builtInCommand.name}`,
					markdown: true,
				});
				if (!delivered) {
					log.logWarn("delivery.command_reply.failed", "Command reply delivery failed", {
						channelId: event.channelId,
						fields: { command: builtInCommand.name, chars: response.length },
					});
				}
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
		internalWake: NonNullable<WakeEvent["internalWake"]>,
	) => {
		const event = turn.event as WakeEvent;
		const { kind, resourceId, taskId: wakeTaskId } = internalWake;
		const { desk, deskDir } = runner.conversation;
		const claimed = await claimVerifiedWake(
			event,
			deskDir,
			kind === "job" ? getJobs().get(desk) : getRuns().get(desk),
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
		transport: Transport,
		backgroundOnly: boolean,
	): Promise<void> => {
		const { event } = turn;
		const sender = senderOf(event);
		// Computed before archiving so a command's own text can be excluded from
		// memory-extraction input (review 2026-08-24 §1.2): it is control-plane
		// traffic, not conversation, and the history stays queryable via session_search.
		const structuredInput = event.source === "human" && Boolean(event.context?.messages.length);
		const builtInCommand = structuredInput ? undefined : parseBuiltInCommand(event.text);
		await archiveIncomingMessage(
			event.channelId,
			{
				date: new Date().toISOString(),
				ts: event.ts,
				...sender,
				text: event.text,
				isBot: false,
				skipContextSync: Boolean(builtInCommand),
				images: relativeImagePaths(runner.conversation.deskDir, event.images),
			},
			"user message",
		);

		if (builtInCommand) {
			// A command draws no progress: its output port is quiet, and it closes with the turn.
			turn.output = trackOutput(transport.openTurn(turnInfoOf(event), { quiet: true }));
			await runBuiltinCommand(turn, builtInCommand, runner, transport);
			return;
		}

		// Reject an unknown slash command instead of spending a full LLM turn
		// letting the model guess what `/modle` meant. Session commands,
		// skills, and prompt templates are recognized by isKnownSlashCommand.
		if (!structuredInput && event.text.trim().startsWith("/") && !runner.isKnownSlashCommand(event.text)) {
			const name = slashCommandName(event.text) ?? "";
			turn.output = trackOutput(transport.openTurn(turnInfoOf(event), { quiet: true }));
			await replyTo(transport, event, formatUnknownCommandMessage(name));
			return;
		}

		log.logEvent("info", "agent.turn.started", "Starting turn", {
			ctx: { channelId: event.channelId, userName: sender.userName },
			fields: { messageLength: event.text.length, source: backgroundOnly ? "event" : "message" },
		});
		if (
			event.source === "wake" &&
			event.internalWake &&
			!(await verifyInternalWake(turn, runner, event.internalWake))
		)
			return;
		// Verified job/run wakes that activate a task are task steps too. Verification must happen
		// first: routing directly from user-controlled wake text would grant task-only tools.
		const taskStep = await prepareTaskStep(turn.event, runner);
		if (taskStep) {
			turn.event = { ...turn.event, text: taskStep.brief };
		}
		// Background wakes deliver their result, not their process: no progress card, no
		// thinking stream, nothing to clean up when a check-in ends `[SILENT]`. Awaited completions
		// deliver their result too, without opening another progress card.
		// Spec 051, D3: a task-driver dispatch runs as a *task step* — in the task cycle's own
		// session, with a brief instead of the wake text, and silent unless the step asked for a
		// notify. Everything below (busy state, /stop, delivery) is unchanged; only which session
		// the turn is bound to, and what reaches the channel, differ.
		const info = turnInfoOf(turn.event);
		const opened = transport.openTurn(info, { quiet: backgroundOnly || taskStep !== undefined });
		turn.output = trackOutput(taskStep ? silenceAnswers(opened) : opened);
		const result = await runner.run(info, turn.output.ctx, store);
		if (!deps.isCurrentRunner(runner)) return;
		turn.mergedWakesHandled = result.stopReason !== "aborted" && result.stopReason !== "error";
		if (taskStep) await finishTaskStep(runner, turn.event.channelId, taskStep.taskId, transport);

		if (result.stopReason === "aborted" && runner.getTurnStatus().stopRequested) {
			log.logInfoEvent("agent.turn.stopped", "Turn stopped", { channelId: turn.event.channelId });
		}
	};

	/** Always runs: finish the output, settle the dispatch records, release the turn, nudge the task driver. */
	const finishTurn = async (turn: TurnState, runner: AgentRunner): Promise<void> => {
		const { event } = turn;
		// The runner finishes the output when it runs; a command, or a turn that failed before the
		// runner took over, finishes here so the transport never keeps one open.
		if (turn.output && !turn.output.finished) {
			const outcome: TurnOutcome = {
				kind: "completed",
				usage: createEmptyUsageTotals(),
				executionDesk: runner.conversation.desk,
			};
			await turn.output.ctx.finish(outcome).catch((error: unknown) => {
				log.logWarn("delivery.close.failed", "Delivery close failed", {
					channelId: event.channelId,
					reason: errorMessage(error),
				});
			});
		}
		if (!deps.isCurrentRunner(runner)) {
			runner.endTurn();
			return;
		}
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
	 * A task-bound wake dropped at admission because its channel left the wake's desk while it was
	 * queued. No turn runs, but the business side settles exactly as when the producer suppresses
	 * the wake itself: the owner verifies and claims it and the task's `work` ticket is redeemed, so
	 * the task resumes as soon as its channel is bound back instead of waiting out the backstop.
	 */
	const settleDroppedTaskWake = async (event: WakeEvent): Promise<void> => {
		const wake = event.internalWake;
		if (!wake) return;
		try {
			const owner = wake.kind === "job" ? getJobs().get(event.desk) : getRuns().get(event.desk);
			const claimed = await claimVerifiedWake(event, getDeskDir(options.paths.workspaceDir, event.desk), owner);
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
	 * A human message on a channel with no usable desk (D4): nothing is archived, no runner is built
	 * and no model is called. `/help` still answers (and `/desk`, before this); everything else gets
	 * the one reason and the next step.
	 */
	const replyWithoutDesk = async (
		event: ChannelEvent,
		resolution: Exclude<ChannelResolution, { kind: "bound" }>,
		transport: Transport,
	): Promise<void> => {
		const command = parseBuiltInCommand(event.text);
		if (command?.name === "help") {
			await replyTo(transport, event, renderBuiltInHelp(command.args), { title: "/help", markdown: true });
			return;
		}
		await replyTo(transport, event, formatNoDeskReply(resolution), { markdown: true });
	};

	/**
	 * A human message that only gets an answer — a command, a refusal — still has its own turn as
	 * far as the transport is concerned: its output port is opened and finished around the reply,
	 * so a transport that follows each message to an end (the Web API) always sees one.
	 */
	const answerOnly = async (transport: Transport, event: ChannelEvent, work: () => Promise<void>): Promise<void> => {
		const output = trackOutput(transport.openTurn(turnInfoOf(event), { quiet: true }));
		try {
			await work();
		} finally {
			const executionDesk = resolvedDesk(deps.resolveChannel(event.channelId));
			await output.ctx
				.finish({
					kind: "completed",
					usage: createEmptyUsageTotals(),
					...(executionDesk !== undefined ? { executionDesk } : {}),
				})
				.catch((error: unknown) => {
					log.logWarn("delivery.close.failed", "Delivery close failed", {
						channelId: event.channelId,
						reason: errorMessage(error),
					});
				});
		}
	};

	const runDeskCommand = async (event: ChannelEvent, args: string, transport: Transport): Promise<void> => {
		const logCtx = { channelId: event.channelId, userName: senderOf(event).userName };
		log.logEvent("info", "runtime.command.started", "Executing command", {
			ctx: logCtx,
			fields: { command: "desk" },
		});
		const response = await deps.runRuntimeCommand(event, "desk", args);
		const delivered = await replyTo(transport, event, response, { title: "/desk", markdown: true });
		if (!delivered) {
			log.logWarn("delivery.command_reply.failed", "Command reply delivery failed", {
				channelId: event.channelId,
				fields: { command: "desk", chars: response.length },
			});
		}
	};

	const runEventTurn = async (inboundEvent: ChannelEvent): Promise<void> => {
		if (isShuttingDown()) {
			log.logInfoEvent("runtime.shutdown.event_ignored", "Event ignored during shutdown", {
				channelId: inboundEvent.channelId,
			});
			return;
		}
		const transport = transports.forChannel(inboundEvent.channelId);
		if (!transport) {
			log.logWarn("runtime.turn.no_transport", "Turn dropped: no transport hosts the channel", {
				channelId: inboundEvent.channelId,
				fields: { dispatchId: inboundEvent.dispatchId },
			});
			releaseReservation(inboundEvent);
			return;
		}

		const resolution = deps.resolveChannel(inboundEvent.channelId);
		if (isSyntheticEvent(inboundEvent)) {
			// D7's authoritative check (the rule is `admitsSyntheticEvent`; `reserveEvent` applies it early).
			if (!admitsSyntheticEvent(resolution, inboundEvent)) {
				log.logInfoEvent("dispatch.wake.desk_mismatch", "Wake dropped: channel not bound to the wake's desk", {
					channelId: inboundEvent.channelId,
					fields: {
						dispatchId: inboundEvent.dispatchId,
						wakeDesk: inboundEvent.desk,
						boundDesk: resolvedDesk(resolution),
					},
				});
				releaseReservation(inboundEvent);
				await settleDroppedTaskWake(inboundEvent);
				await getDurableDispatch()?.markCompleted(inboundEvent.dispatchId);
				return;
			}
		} else {
			// `/desk` runs outside any turn, bound or not: nothing is archived and no runner is built,
			// so `/desk bind` sees this channel idle and the next queued message already resolves
			// against the new binding (D5).
			const command = parseBuiltInCommand(inboundEvent.text);
			// Authorization is checked where the work runs, not only where it was admitted: a queued
			// message outlives the binding it arrived under (an earlier `/desk bind` may have moved it).
			const boundDesk = resolvedDesk(resolution);
			if (
				inboundEvent.allowedDesks &&
				boundDesk !== undefined &&
				!inboundEvent.allowedDesks.includes(boundDesk) &&
				command?.name !== "desk"
			) {
				await answerOnly(transport, inboundEvent, () =>
					replyTo(transport, inboundEvent, `当前身份无权使用工位 \`${boundDesk}\`。`).then(() => undefined),
				);
				return;
			}
			if (command?.name === "desk") {
				releaseReservation(inboundEvent);
				await answerOnly(transport, inboundEvent, () => runDeskCommand(inboundEvent, command.args, transport));
				return;
			}
			if (resolution.kind !== "bound") {
				await answerOnly(transport, inboundEvent, () => replyWithoutDesk(inboundEvent, resolution, transport));
				return;
			}
		}

		const runner = getRunner(inboundEvent.channelId);
		if (!runner) {
			// The binding went away since the checks above: nothing can run, but the message still ends.
			if (!isSyntheticEvent(inboundEvent)) await answerOnly(transport, inboundEvent, async () => undefined);
			return;
		}
		const turn = await admitTurn(inboundEvent, runner);
		if (!turn) return;
		const task = (async () => {
			try {
				await executeTurn(turn, runner, transport, isSyntheticEvent(inboundEvent));
			} catch (err) {
				log.logEvent("error", "agent.turn.failed", "Turn failed", {
					ctx: { channelId: turn.event.channelId, userName: senderOf(turn.event).userName },
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
