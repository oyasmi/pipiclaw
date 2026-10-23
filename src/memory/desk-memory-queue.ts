import { getDeskLockPath } from "../desk/paths.js";
import type { DeskConversation } from "../desk/types.js";
import { FileLockTimeoutError, withFileLock } from "../shared/file-lock.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { createSerialQueue } from "../shared/serial-queue.js";

/** The desk whose memory a job writes: its name is the queue key, its directory holds the lock. */
export type DeskMemoryTarget = Pick<DeskConversation, "desk" | "deskDir">;

/**
 * The one serialization point for a desk's memory (`MEMORY.md`, `memory/`, `journal/`,
 * `memory-review.jsonl`) — spec 058, INV-8. Every writer goes through it: `memory_save` /
 * `memory_forget`, the idle reflect job, the boundary reflect in `lifecycle.ts`, and `/memory`.
 *
 * Keyed by **desk name**, not channel: two channels bound to one desk write the same files, and a
 * per-channel key would let them run concurrently. Inside the in-process queue each job also
 * holds `<desk>/.locks/memory.lock`, because a TUI may write the same desk from another process.
 */
export interface DeskMemoryQueue {
	run<T>(target: DeskMemoryTarget, job: () => Promise<T>): Promise<T>;
}

/**
 * The lock is held across a whole reflect pass, model call included (45s timeout, plus one
 * fallback attempt), so a waiter must outlast that before concluding the holder is stuck.
 */
const MEMORY_LOCK_TIMEOUT_MS = 150_000;

export function createDeskMemoryQueue(): DeskMemoryQueue {
	const queue = createSerialQueue<string>();
	return {
		run<T>(target: DeskMemoryTarget, job: () => Promise<T>): Promise<T> {
			return queue.run(target.desk, async () => {
				try {
					return await withFileLock(getDeskLockPath(target.deskDir, "memory.lock"), job, {
						timeoutMs: MEMORY_LOCK_TIMEOUT_MS,
					});
				} catch (error) {
					if (!(error instanceof FileLockTimeoutError)) throw error;
					throw new RecoverableToolError(
						`Memory of desk "${target.desk}" is being written by another Pipiclaw process${
							error.heldBy ? ` (pid ${error.heldBy.pid})` : ""
						}; retry in a moment.`,
					);
				}
			});
		},
	};
}

const deskMemoryQueue = createDeskMemoryQueue();

/** The process-wide instance every memory writer shares; never construct a second one in production. */
export function getDeskMemoryQueue(): DeskMemoryQueue {
	return deskMemoryQueue;
}
