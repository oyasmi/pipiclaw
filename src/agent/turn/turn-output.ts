/**
 * A turn's output port as the agent sees it: the transport's `ChannelContext` behind a gate. Once
 * the turn is stopped or retired nothing more reaches the channel — a late event from the aborted
 * provider must not draw over the next turn — and `finish` reaches the transport exactly once.
 */
import type { ChannelContext, TurnEvent, TurnOutcome } from "../../channel/channel-context.js";
import * as log from "../../log.js";
import { errorMessage } from "../../shared/text-utils.js";

export class TurnOutput {
	private closed = false;
	private finishing: Promise<void> | undefined;

	constructor(
		private readonly ctx: ChannelContext,
		private readonly channelId: string,
	) {}

	emit(event: TurnEvent): void {
		if (this.closed) return;
		try {
			this.ctx.emit(event);
		} catch (error) {
			log.logWarn("delivery.emit.failed", "Turn event delivery failed", {
				channelId: this.channelId,
				reason: errorMessage(error),
				fields: { type: event.type },
			});
		}
	}

	/** End the turn now (the user stopped it, or its generation was retired): later events are dropped. */
	cancel(outcome: Pick<TurnOutcome, "usage">): Promise<void> {
		return this.finish({ kind: "cancelled", usage: outcome.usage });
	}

	/** The transport sees only the first outcome; a later call returns the same settlement. */
	finish(outcome: TurnOutcome): Promise<void> {
		this.closed = true;
		this.finishing ??= this.ctx.finish(outcome).catch((error: unknown) => {
			log.logWarn("delivery.finish.failed", "Turn output finish failed", {
				channelId: this.channelId,
				reason: errorMessage(error),
			});
		});
		return this.finishing;
	}

	get isFinished(): boolean {
		return this.finishing !== undefined;
	}
}
