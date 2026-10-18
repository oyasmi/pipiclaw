import { join } from "node:path";
import { normalizeTaskId } from "./contract.js";

/**
 * Where a task's own agent session lives (spec 051, D3; one per task since spec 052, D1) —
 * left behind when the task is archived. Kept out of `<dotDir>` root and under a dot-directory so
 * `session_search`'s channel scan and `/new`'s session listing do not mistake a task transcript
 * for the channel's conversation.
 */
export const TASK_SESSIONS_DIRNAME = ".sessions";

export function taskSessionsDir(dotDir: string): string {
	return join(dotDir, "tasks", TASK_SESSIONS_DIRNAME);
}

export function taskSessionPath(dotDir: string, taskId: string): string {
	return join(taskSessionsDir(dotDir), `${normalizeTaskId(taskId)}.jsonl`);
}
