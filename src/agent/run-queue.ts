import * as log from "../log.js";
import { errorMessage } from "../shared/text-utils.js";
import type { RunQueue } from "./types.js";

export interface CreatedRunQueue {
	queue: RunQueue;
	drain: () => Promise<void>;
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
		drain: async () => {
			await queueChain;
		},
	};
}
