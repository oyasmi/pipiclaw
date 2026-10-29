import { readLastOutputAt, STALL_THRESHOLD_MS } from "../subagents/external/progress-tail.js";
import type { TaskPendingWork } from "../tasks/control.js";
import type { TaskLaneOptions } from "./task-lane-types.js";

/**
 * Delegations and background jobs bound to a task and not yet settled — the facts a task's wait
 * is derived from (spec 064, D8/INV-4). Read from the run and job managers, which also own each
 * one's hard deadline.
 */
export async function listPendingWork(
	options: Pick<TaskLaneOptions, "getRuns" | "getJobs">,
	desk: string,
	now: number,
	withActivity = false,
): Promise<Map<string, TaskPendingWork[]>> {
	const byTask = new Map<string, TaskPendingWork[]>();
	await options.getRuns(desk).retryTaskSettlements?.();
	const add = (taskId: string, work: TaskPendingWork) => {
		const list = byTask.get(taskId);
		if (list) list.push(work);
		else byTask.set(taskId, [work]);
	};
	for (const run of options.getRuns(desk).list()) {
		if (!run.taskId || run.settledAt !== undefined) continue;
		let lastOutputAt: number | undefined;
		if (withActivity && run.runtime === "external") lastOutputAt = await readLastOutputAt(run.artifactDir);
		const quietSince = lastOutputAt ?? run.processStartedAt ?? run.startedAt;
		add(run.taskId, {
			ref: run.runId,
			kind: "delegation",
			label: run.agent,
			startedAt: run.startedAt,
			...(lastOutputAt !== undefined ? { lastOutputAt } : {}),
			stalled: run.runtime === "external" && withActivity && now - quietSince >= STALL_THRESHOLD_MS,
		});
	}
	const jobs = await options.getJobs(desk).list();
	for (const job of jobs) {
		if (!job.taskId || job.status !== "running") continue;
		add(job.taskId, { ref: job.id, kind: "job", label: job.label, startedAt: job.startedAt, stalled: false });
	}
	return byTask;
}
