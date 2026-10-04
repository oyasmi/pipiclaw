import { appendTaskLog, type TaskDispatchRecord, type TaskSettleRecord } from "./log.js";
import { readStoredTask, updateStoredTask } from "./store.js";

/**
 * The run and job managers' only way to tell a task about work bound to it (spec 052, D4).
 *
 * Both are best-effort by design: a task whose file has since been archived or hand-deleted must
 * not block a completion wake, and a failed log write must not fail a dispatch. Each caller guards
 * these with its own idempotency marker (`taskAccounted` for runs, `taskLogged` for jobs) so a
 * replayed settlement writes nothing twice.
 */

/** Record that a delegation or job was bound to the task. A task that no longer exists is skipped. */
export async function logTaskDispatch(
	channelDir: string,
	taskId: string,
	record: Omit<TaskDispatchRecord, "ts" | "kind">,
): Promise<void> {
	if (!(await readStoredTask(channelDir, taskId))) return;
	await appendTaskLog(channelDir, taskId, { kind: "dispatch", ...record });
}

export interface TaskSettlementCost {
	usd: number;
	estimated: boolean;
}

/**
 * Record that bound work settled and add its cost to the task's usage. The cost lands in the
 * same budget the leader's own steps spend from, so a runaway fan-out stops the task.
 */
export async function logTaskSettlement(
	channelDir: string,
	taskId: string,
	record: Omit<TaskSettleRecord, "ts" | "kind" | "usd" | "usdEstimated">,
	cost: TaskSettlementCost = { usd: 0, estimated: false },
): Promise<void> {
	if (cost.usd > 0 || cost.estimated) {
		await updateStoredTask(channelDir, taskId, (task) => {
			const usage = task.fields.usage;
			if (!usage) return;
			task.fields.usage = {
				...usage,
				usd: usage.usd + Math.max(0, cost.usd),
				usdEstimated: usage.usdEstimated || cost.estimated,
			};
		});
	}
	if (!(await readStoredTask(channelDir, taskId))) return;
	await appendTaskLog(channelDir, taskId, {
		kind: "settle",
		...record,
		...(cost.usd > 0 ? { usd: cost.usd } : {}),
		...(cost.estimated ? { usdEstimated: true } : {}),
	});
}
