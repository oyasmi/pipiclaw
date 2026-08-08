import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import { withTimeout } from "../shared/with-timeout.js";
import type { RunQueue } from "./types.js";

/**
 * Ceiling on how long `drain()` blocks the caller. The queue carries outbound
 * delivery calls plus whatever a session event enqueued (a resource refresh, a
 * store write); any one of them stalling used to hold `run()`'s epilogue — and
 * therefore the channel's busy state — open with no bound and no log line.
 * Draining continues in the background after the deadline; only the waiter is
 * released.
 */
export const DRAIN_DEADLINE_MS = 60_000;

export interface CreatedRunQueue {
	queue: RunQueue;
	drain: (deadlineMs?: number) => Promise<void>;
}

export function createRunQueue(): CreatedRunQueue {
	let queueChain = Promise.resolve();
	const queue: RunQueue = {
		enqueue: (fn: () => Promise<void>, errorContext: string): void => {
			queueChain = queueChain.then(async () => {
				try {
					await fn();
				} catch (err) {
					const errMsg = errorMessage(err);
					log.logWarning(`DingTalk API error (${errorContext})`, errMsg);
				}
			});
		},
	};

	return {
		queue,
		drain: async (deadlineMs: number = DRAIN_DEADLINE_MS) => {
			try {
				await withTimeout("run queue drain", deadlineMs, async () => {
					await queueChain;
				});
			} catch (err) {
				log.logWarning("Run queue drain deadline exceeded; releasing the turn", errorMessage(err));
			}
		},
	};
}
