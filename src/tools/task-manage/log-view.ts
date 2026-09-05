import { normalizeTaskId } from "../../tasks/ledger.js";
import { readTaskLog, renderTaskLogLine } from "../../tasks/log.js";
import type { TaskLogRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * `task_log` — read the loop log (spec 051, D5).
 *
 * This is what makes the 4 KB contract affordable: the history the task file used to carry
 * inline is still there, just addressed on demand instead of injected into every step.
 */
export async function readTaskLogTool(
	options: TaskManageToolOptions,
	request: TaskLogRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const limit = Math.min(Math.max(1, Math.trunc(request.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
	const records = await readTaskLog(options.channelDir, id, { cycle: request.cycle, limit });
	const entries = records.map(renderTaskLogLine);
	return {
		action: "log",
		id,
		entries,
		notice:
			entries.length === 0
				? `任务 \`${id}\` 暂无循环日志${request.cycle ? `（周期 ${request.cycle}）` : ""}。`
				: `任务 \`${id}\` 最近 ${entries.length} 条记录${request.cycle ? `（周期 ${request.cycle}）` : ""}。`,
	};
}
