import type { DingTalkContext } from "../runtime/dingtalk.js";
import * as log from "../log.js";
import type { RunQueue } from "./types.js";

export interface CreatedRunQueue {
	queue: RunQueue;
	drain: () => Promise<void>;
}

export function createRunQueue(ctx: DingTalkContext): CreatedRunQueue {
	let queueChain = Promise.resolve();
	const queue: RunQueue = {
		enqueue: (fn: () => Promise<void>, errorContext: string): void => {
			queueChain = queueChain.then(async () => {
				try {
					await fn();
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning(`DingTalk API error (${errorContext})`, errMsg);
				}
			});
		},
		enqueueMessage: function (text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
			this.enqueue(() => (target === "main" ? ctx.respond(text, doLog) : ctx.respondInThread(text)), errorContext);
		},
	};

	return {
		queue,
		drain: async () => {
			await queueChain;
		},
	};
}
