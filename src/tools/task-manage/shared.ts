import { join } from "node:path";
import { uncheckedTaskAcceptanceItems } from "../../tasks/contract.js";
import type { StoredTaskDocument } from "../../tasks/store.js";
import { RecoverableToolError } from "../contract/details.js";
import type { TaskManageToolOptions } from "./types.js";

export function tasksDir(options: TaskManageToolOptions): string {
	return join(options.deskDir, "tasks");
}

export function requiredField(value: string | undefined, field: string, action: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new RecoverableToolError(`${action} requires ${field}.`);
	return trimmed;
}

/** Refs of the delegations and background jobs bound to `taskId` that have not settled yet. */
export async function pendingWorkRefs(options: TaskManageToolOptions, taskId: string): Promise<string[]> {
	const refs: string[] = [];
	for (const run of options.runManager.list()) {
		if (run.taskId === taskId && run.settledAt === undefined) refs.push(run.runId);
	}
	const jobs = await options.jobManager.list().catch(() => []);
	for (const job of jobs) {
		if (job.taskId === taskId && job.status === "running") refs.push(job.id);
	}
	return refs;
}

/**
 * The gates on completing a task (spec 052, D6; spec 064, D22). Both are about the *leader's* own
 * state rather than any runtime proof: every DoD item is checked off, and nothing bound to the task
 * is still in flight (otherwise the project would be archived and the late result would fall back
 * into the chat). Cancelling has neither gate — abandoning work must always be possible.
 */
export async function assertCompletable(
	options: TaskManageToolOptions,
	document: StoredTaskDocument,
	id: string,
): Promise<void> {
	const unchecked = uncheckedTaskAcceptanceItems(document.body);
	if (unchecked.length > 0) {
		throw new RecoverableToolError(
			`Task "${id}" still has unmet acceptance items: ${unchecked.slice(0, 3).join("; ")}. Check them off with edit once the evidence holds.`,
		);
	}
	const pending = await pendingWorkRefs(options, id);
	if (pending.length > 0) {
		throw new RecoverableToolError(
			`Task "${id}" still has work in flight (${pending.join(", ")}). End the step; in-flight work wakes you when it settles. Or cancel it with subagent_run / job before finishing.`,
		);
	}
}
