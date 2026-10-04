import { join } from "node:path";
import { normalizeTaskId } from "./ledger.js";

/**
 * Where a task's own agent session lives (spec 051, D3; one per task since spec 052, D1) —
 * left behind when the task is archived. Kept out of `<channelDir>` root and under a dot-directory so
 * `session_search`'s channel scan and `/new`'s session listing do not mistake a task transcript
 * for the channel's conversation.
 */
export const TASK_SESSIONS_DIRNAME = ".sessions";

export function taskSessionsDir(channelDir: string): string {
	return join(channelDir, "tasks", TASK_SESSIONS_DIRNAME);
}

export function taskSessionPath(channelDir: string, taskId: string): string {
	return join(taskSessionsDir(channelDir), `${normalizeTaskId(taskId)}.jsonl`);
}
