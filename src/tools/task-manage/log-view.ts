import { normalizeTaskId } from "../../tasks/ledger.js";
import { readTaskLog, renderTaskLogLine, taskLogIsArchived } from "../../tasks/log.js";
import type { TaskLogRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * `task_log` — read the loop log (spec 051, D5).
 *
 * This is what makes the small contract affordable: the history the task file used to carry
 * inline is still there, just addressed on demand instead of injected into every step. It also
 * shows the dispatch/settle records the step brief folds into the board.
 */
export async function readTaskLogTool(
	options: TaskManageToolOptions,
	request: TaskLogRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const limit = Math.min(Math.max(1, Math.trunc(request.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
	const archived = taskLogIsArchived(options.channelDir, id);
	const records = await readTaskLog(options.channelDir, id, { limit });
	const entries = records.map(renderTaskLogLine);
	const archivedTag = archived ? "（已归档任务）" : "";
	return {
		action: "log",
		id,
		entries,
		notice:
			entries.length === 0
				? `任务 \`${id}\` 暂无循环日志${archivedTag}。`
				: `任务 \`${id}\` 最近 ${entries.length} 条记录${archivedTag}。`,
	};
}
