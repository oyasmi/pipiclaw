/**
 * The per-channel serial work queue for inbound turns (the limits that apply to it live in
 * `ingress.ts`).
 */
import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";

export type QueuedWork = () => Promise<void>;

interface QueuedItem {
	work: QueuedWork;
	/** The transport's reference for the message this work answers, so it can be taken back out. */
	ref?: string;
}

/**
 * The per-channel turn serialization point: a channel processes one inbound message at a time;
 * later arrivals wait here. Busy state itself is owned by the runner's turn state machine
 * (`AgentRunner.beginTurn`), not by this queue.
 */
export class ChannelQueue {
	private queue: QueuedItem[] = [];
	private processing = false;
	private stopped = false;

	enqueue(work: QueuedWork, ref?: string): void {
		if (this.stopped) return;
		this.queue.push({ work, ref });
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	/** True only when no queued or in-flight work still owns this channel. */
	isIdle(): boolean {
		return !this.processing && this.queue.length === 0;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.stopped || this.queue.length === 0) return;
		this.processing = true;
		const { work } = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarn("runtime.queue.item_failed", "Channel queue item failed", { reason: errorMessage(err) });
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

	/** Take one not-yet-started item back out by its `ref`; whether it was found. */
	removeByRef(ref: string): boolean {
		const index = this.queue.findIndex((item) => item.ref === ref);
		if (index < 0) return false;
		this.queue.splice(index, 1);
		return true;
	}
}
