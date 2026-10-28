import { appendTaskLog, type TaskDispatchRecord, type TaskSettleRecord } from "./loop-log.js";
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
	deskDir: string,
	taskId: string,
	record: Omit<TaskDispatchRecord, "ts" | "kind">,
): Promise<void> {
	if (!(await readStoredTask(deskDir, taskId))) return;
	await appendTaskLog(deskDir, taskId, { kind: "dispatch", ...record });
}

export interface TaskSettlementCost {
	usd: number;
	estimated: boolean;
}

/**
 * Record that bound work settled and add its cost to the task's usage. The cost lands in the
 * same budget the leader's own steps spend from, so a runaway fan-out stops the task. Returns
 * whether the task still existed to receive the record — callers fall back to a chat wake when it
 * did not (spec 064, D19).
 */
export async function logTaskSettlement(
	deskDir: string,
	taskId: string,
	record: Omit<TaskSettleRecord, "ts" | "kind" | "usd" | "usdEstimated">,
	cost: TaskSettlementCost = { usd: 0, estimated: false },
): Promise<boolean> {
	if (cost.usd > 0 || cost.estimated) {
		await updateStoredTask(deskDir, taskId, (task) => {
			const usage = task.fields.usage;
			if (!usage) return;
			task.fields.usage = {
				...usage,
				usd: usage.usd + Math.max(0, cost.usd),
				usdEstimated: usage.usdEstimated || cost.estimated,
			};
		});
	}
	if (!(await readStoredTask(deskDir, taskId))) return false;
	await appendTaskLog(deskDir, taskId, {
		kind: "settle",
		...record,
		...(cost.usd > 0 ? { usd: cost.usd } : {}),
		...(cost.estimated ? { usdEstimated: true } : {}),
	});
	return true;
}

/** An external run bound to the task has been silent for `silentMinutes`: an input the leader judges (D16). */
export async function logTaskStall(
	deskDir: string,
	taskId: string,
	record: { ref: string; silentMinutes: number },
): Promise<boolean> {
	if (!(await readStoredTask(deskDir, taskId))) return false;
	await appendTaskLog(deskDir, taskId, { kind: "stall", ...record });
	return true;
}
