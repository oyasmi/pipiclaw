import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { createSerialQueue } from "../shared/serial-queue.js";
import { normalizeTaskId } from "./ledger.js";

const mutationQueue = createSerialQueue<string>();
const heldKeys = new AsyncLocalStorage<ReadonlySet<string>>();

function taskMutationKey(channelDir: string, id: string): string {
	return join(channelDir, "tasks", `${normalizeTaskId(id)}.md`);
}

/**
 * Serialize mutations of one task inside this process.
 *
 * Pipiclaw deliberately supports one process per workspace; cross-process sharing remains
 * unsupported. Re-entrancy is required because a command/tool transaction may call a lower-level
 * store helper for the same task.
 */
export function withTaskMutation<T>(channelDir: string, id: string, mutate: () => Promise<T>): Promise<T> {
	const key = taskMutationKey(channelDir, id);
	const current = heldKeys.getStore();
	if (current?.has(key)) return mutate();

	return mutationQueue.run(key, () => heldKeys.run(new Set([...(current ?? []), key]), mutate));
}
