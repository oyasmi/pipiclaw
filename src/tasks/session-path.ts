import { join } from "node:path";
import { normalizeTaskId } from "./ledger.js";

/**
 * Where a task cycle's own agent session lives (spec 051, D3) — one file per cycle, closed and
 * left behind when the cycle ends. Kept out of `<channelDir>` root and under a dot-directory so
 * `session_search`'s channel scan and `/new`'s session listing do not mistake a task transcript
 * for the channel's conversation.
 */
export const TASK_SESSIONS_DIRNAME = ".sessions";

export function taskSessionsDir(channelDir: string): string {
	return join(channelDir, "tasks", TASK_SESSIONS_DIRNAME);
}

export function taskSessionPath(channelDir: string, taskId: string, cycleId: string): string {
	const safeCycle = cycleId.replace(/[^A-Za-z0-9._-]/g, "-");
	return join(taskSessionsDir(channelDir), `${normalizeTaskId(taskId)}-${safeCycle}.jsonl`);
}
