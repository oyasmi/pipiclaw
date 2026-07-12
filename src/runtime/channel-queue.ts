import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";

export type QueuedWork = () => Promise<void>;

/**
 * The per-channel turn serialization point: a channel processes one inbound
 * message at a time; later arrivals wait here. This is runtime policy, not a
 * transport detail — DingTalk consumes it via `DingTalkBot`; busy-state itself
 * is owned by the runner's turn state machine (`AgentRunner.beginTurn`).
 */
export class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;
	private stopped = false;

	enqueue(work: QueuedWork): void {
		if (this.stopped) return;
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.stopped || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", errorMessage(err));
		}
		this.processing = false;
		this.processNext();
	}

	stop(): void {
		this.stopped = true;
		this.queue = [];
	}

	// Drop not-yet-started work without disabling the queue. Used by /stop so a
	// burst of queued messages does not keep running after the user asked to halt.
	// The in-flight item (already shifted) is unaffected; the caller aborts it.
	clearPending(): number {
		const dropped = this.queue.length;
		this.queue = [];
		return dropped;
	}
}
