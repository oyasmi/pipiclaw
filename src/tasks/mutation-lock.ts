import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { FileLockTimeoutError, withFileLock } from "../shared/file-lock.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { normalizeTaskId } from "./contract.js";

const mutationQueue = createSerialQueue<string>();
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * A task mutation is a few small file writes; waiting longer than this means the other process
 * is stuck, and the caller is better off retrying than hanging a tool call or a driver tick.
 */
const TASK_LOCK_TIMEOUT_MS = 30_000;

function taskMutationKey(dotDir: string, id: string): string {
	return join(dotDir, "tasks", `${normalizeTaskId(id)}.md`);
}

/** `<dotDir>/.locks/task-<id>.lock` — the layout `dot/paths.ts` defines; tasks stays a leaf and does not import it. */
function taskLockPath(dotDir: string, id: string): string {
	return join(dotDir, ".locks", `task-${normalizeTaskId(id)}.lock`);
}

/**
 * Serialize mutations of one task: inside this process with a serial queue, and across processes
 * with the task's file lock (spec 058, D6) — the daemon and a TUI can open the same dot, and both
 * may write its tasks. Every writer of a task's contract, loop log or steer/notice files goes
 * through here.
 *
 * Re-entrant: a command/tool transaction may call a lower-level store helper for the same task,
 * and the inner call then runs inside the outer one's hold on both layers.
 */
export function withTaskMutation<T>(dotDir: string, id: string, mutate: () => Promise<T>): Promise<T> {
	const key = taskMutationKey(dotDir, id);
	const current = heldKeys.getStore();
	if (current?.has(key)) return mutate();

	return mutationQueue.run(key, () =>
		heldKeys.run(new Set([...(current ?? []), key]), async () => {
			try {
				return await withFileLock(taskLockPath(dotDir, id), mutate, { timeoutMs: TASK_LOCK_TIMEOUT_MS });
			} catch (error) {
				if (!(error instanceof FileLockTimeoutError)) throw error;
				throw new RecoverableToolError(
					`Task "${normalizeTaskId(id)}" is being modified by another Pipiclaw process${
						error.heldBy ? ` (pid ${error.heldBy.pid})` : ""
					}; retry this call in a moment.`,
				);
			}
		}),
	);
}
