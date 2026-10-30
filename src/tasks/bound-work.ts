import { appendTaskLog, readTaskLog, type TaskDispatchRecord, type TaskSettleRecord } from "./loop-log.js";
import { withTaskMutation } from "./mutation-lock.js";
import { commitTask, readStoredTask } from "./store.js";

/**
 * The run and job managers' only way to tell a task about work bound to it (spec 052, D4).
 *
 * Dispatch logs may be best-effort. Settlement logs and cost are committed together; ref-based
 * deduplication lets the owning managers retry a failed receipt without charging twice.
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
	known?: boolean;
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
	return withTaskMutation(deskDir, taskId, async () => {
		const task = await readStoredTask(deskDir, taskId);
		if (!task) return false;
		if (
			(await readTaskLog(deskDir, taskId, { strict: true })).some(
				(entry) => entry.kind === "settle" && entry.ref === record.ref,
			)
		)
			return true;
		if (cost.usd > 0 || cost.estimated || cost.known === false) {
			const usage = task.fields.usage;
			if (usage)
				task.fields.usage = {
					...usage,
					usd: usage.usd + Math.max(0, cost.usd),
					usdEstimated: usage.usdEstimated || cost.estimated,
					...(cost.known === false ? { unknownCostCount: (usage.unknownCostCount ?? 0) + 1 } : {}),
				};
		}
		await commitTask(task, deskDir, {
			kind: "settle",
			...record,
			...(cost.usd > 0 ? { usd: cost.usd } : {}),
			...(cost.estimated ? { usdEstimated: true } : {}),
			...(cost.known === false ? { usdKnown: false } : {}),
		});
		return true;
	});
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
