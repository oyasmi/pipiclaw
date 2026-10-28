/**
 * What the runtime does with a message that arrives while its channel is already running a turn
 * (`/steer`, `/followup`, a plain message under a steering policy), and with `/stop`. These are
 * the branches of `ingress.ts`'s routing that touch the live runner.
 */
import { forceEndStuckTurnAfterStop } from "../agent/stop-watchdog.js";
import type { AgentRunner } from "../agent/types.js";
import type { HumanEvent } from "../channel/channel-event.js";
import { formatMissingQueueMessage, formatSteerQueued } from "../commands/catalog.js";
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { relativeImagePaths } from "./inbound-images.js";
import type { IngressDeps } from "./ingress-deps.js";

function isNoRunningTaskQueueError(err: unknown): boolean {
	return err instanceof Error && err.message === "No task is currently running.";
}

/** How a message that met a busy channel ended up. */
export type BusyOutcome =
	/** It went into the running turn as a steering message. */
	| { kind: "steered" }
	/** The running turn cannot take it: run `text` as a normal turn after it. */
	| { kind: "requeue"; text: string }
	/** Nothing more to do (the user was told, if there was something to tell). */
	| { kind: "handled" };

export function createBusyHandlers(
	deps: IngressDeps,
	queues: {
		clearPending(channelId: string): number;
		reset(channelId: string): number;
	},
) {
	const {
		options,
		channelRunners,
		stopWatchdogs,
		archiveIncomingMessage,
		getRunner,
		isShuttingDown,
		getDurableDispatch,
	} = deps;

	/** Tell the channel something outside any turn. */
	const say = (event: HumanEvent, text: string): Promise<boolean> =>
		deps.pushTo(event.channelId, { text, ...(event.ref !== undefined ? { ref: event.ref } : {}) });

	/**
	 * Hand a message to the turn that is running, per `mode`. `quiet` is for a caller that reports
	 * the result itself (a Web API steer): no confirmation or explanation is sent to the channel.
	 */
	async function handleBusyMessage(
		event: HumanEvent,
		mode: "steer" | "followUp",
		queueText: string,
		quiet = false,
	): Promise<BusyOutcome> {
		if (isShuttingDown()) {
			return { kind: "handled" };
		}

		// A channel is busy only while it has a runner, which only a bound channel ever gets; a
		// binding that disappeared in between is simply run as a normal (refused) turn.
		const runner = getRunner(event.channelId);
		const trimmedQueueText = queueText.trim();
		if (!runner) return { kind: "requeue", text: trimmedQueueText || event.text };

		if (!trimmedQueueText) {
			if (!quiet) await say(event, formatMissingQueueMessage(mode === "followUp" ? "followup" : "steer"));
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
					images: relativeImagePaths(runner.conversation.deskDir, event.images),
				},
				`${mode} message`,
			);

			if (!quiet) await say(event, formatSteerQueued(!event.text.trim().startsWith("/")));
			log.logEvent("info", "agent.turn.steer_queued", "Steer queued", {
				ctx: { channelId: event.channelId, userName: event.userName },
				fields: { messageLength: trimmedQueueText.length },
			});
			return { kind: "steered" };
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
			if (!quiet) {
				await say(
					event,
					`这条消息没能排进当前回合：${errMsg}\n等当前回合结束后重发，或用 \`/followup <消息>\` 排到它之后。`,
				);
			}
			return { kind: "handled" };
		}
	}

	/**
	 * Abort `runner`'s turn, with the watchdog that isolates it if the abort never lands. The turn's
	 * output is ended at once (the card is closed, late events dropped).
	 */
	function abortTurn(channelId: string, runner: AgentRunner): void {
		runner.requestStop();
		void runner.abort().catch((err) => {
			log.logWarn("agent.turn.abort_failed", "Turn abort failed", {
				channelId: channelId,
				reason: errorMessage(err),
			});
		});
		if (stopWatchdogs.has(channelId)) return;
		stopWatchdogs.add(channelId);
		void forceEndStuckTurnAfterStop({
			channelId,
			runner,
			graceMs: options.stopForceEndGraceMs,
			isCurrent: () => channelRunners.get(channelId) === runner,
			recover: () => {
				runner.retireForRecovery();
				channelRunners.delete(channelId);
				queues.reset(channelId);
				getDurableDispatch()?.discardQueuedClaims(channelId);
			},
			notify: (text) => deps.pushTo(channelId, { text }),
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

	/** One message's turn is no longer wanted (its caller cancelled or left): abort only that turn. */
	function cancelRunningTurn(channelId: string): boolean {
		const runner = channelRunners.get(channelId);
		if (!runner?.isBusy()) return false;
		abortTurn(channelId, runner);
		log.logInfoEvent("agent.turn.cancel_requested", "Turn cancel requested", { channelId: channelId });
		return true;
	}

	/** `/stop`: abort the running turn and drop what was queued behind it. Tasks run apart from the chat and are stopped with `/tasks pause` (spec 064, D27). */
	async function handleStop(channelId: string): Promise<void> {
		const runner = channelRunners.get(channelId);
		if (runner?.isBusy()) {
			// The runner ends the turn's output at once (the card is closed, late events dropped).
			runner.requestStop();
			// Drop queued-but-not-started messages so a burst does not keep
			// running after the user asked to halt; abort the in-flight one.
			const dropped = queues.clearPending(channelId);
			// Same tick as the clear: record that absorbed wakes' queued closures are gone.
			getDurableDispatch()?.discardQueuedClaims(channelId);
			if (dropped > 0) {
				log.logInfoEvent("agent.turn.queue_dropped", "Queued messages dropped on /stop", {
					channelId: channelId,
					fields: { count: dropped },
				});
			}
			abortTurn(channelId, runner);
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
		}
	}

	return { handleBusyMessage, handleStop, cancelRunningTurn };
}
