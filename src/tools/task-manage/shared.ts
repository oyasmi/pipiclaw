import { join } from "node:path";
import type { TaskFrontmatter } from "../../tasks/frontmatter.js";
import { uncheckedTaskAcceptanceItems } from "../../tasks/ledger.js";
import { appendTaskLog } from "../../tasks/log.js";
import { archiveTask, type StoredTaskDocument, writeStoredTask } from "../../tasks/store.js";
import { describeTicket, type PendingWorkRef, type TicketContext } from "../../tasks/ticket.js";
import { RecoverableToolError } from "../tool-details.js";
import type { TaskManageToolOptions } from "./types.js";

export function tasksDir(options: TaskManageToolOptions): string {
	return join(options.channelDir, "tasks");
}

export function requiredField(value: string | undefined, field: string, action: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new RecoverableToolError(`${action} requires ${field}.`);
	return trimmed;
}

/** The scheduling half of a lifecycle notice: where the task stands and who will wake it. */
export function describeTaskState(fields: TaskFrontmatter): string {
	if (fields.paused) return `state: ${fields.state}（已暂停：${fields.paused.reason}）`;
	if (fields.state === "parked" && fields.ticket) {
		return `state: parked（${describeTicket(fields.ticket)}；兜底 ${fields.ticket.by}）`;
	}
	return `state: ${fields.state}`;
}

/** A run with no wall-clock limit of its own is given up on after a day, like v4's default backstop. */
const DEFAULT_RUN_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * Delegations and background jobs bound to `taskId` that have not settled yet, each with the
 * instant its owner gives up on it. The registries are read here — once, at the call site —
 * rather than imported inside `ticket.ts`, which is what keeps the whole validation matrix
 * unit-testable against plain fakes.
 */
export async function listPendingWork(options: TaskManageToolOptions, taskId: string): Promise<PendingWorkRef[]> {
	const pending: PendingWorkRef[] = [];
	for (const run of options.runManager.list()) {
		if (run.taskId !== taskId || run.settledAt !== undefined) continue;
		const deadline =
			run.deadlineAt ??
			(run.maxWallTimeSec ? run.startedAt + run.maxWallTimeSec * 1000 : run.startedAt + DEFAULT_RUN_DEADLINE_MS);
		pending.push({ ref: run.runId, deadlineMs: deadline });
	}
	const jobs = await options.jobManager.list().catch(() => []);
	for (const job of jobs) {
		if (job.taskId !== taskId || job.status !== "running") continue;
		pending.push({ ref: job.id, deadlineMs: job.startedAt + job.timeoutSeconds * 1000 });
	}
	return pending;
}

export async function buildTicketContext(
	options: TaskManageToolOptions,
	taskId: string,
	now: Date = new Date(),
): Promise<TicketContext> {
	const pending = await listPendingWork(options, taskId);
	return { now, pendingWork: () => pending };
}

export interface CloseTaskInput {
	options: TaskManageToolOptions;
	document: StoredTaskDocument;
	id: string;
	outcome: "complete" | "cancel";
	note: string;
	/** Steps the loop log should record; defaults to the task's own counter. */
	steps?: number;
	/**
	 * Runs after every check has passed and before the close record is written. `task_step_end`
	 * records its own step here: it has to land in the active log (archiving moves the log away) and
	 * must not land at all if a check rejects the close, or a corrected retry would log it twice.
	 */
	afterChecks?: () => Promise<void>;
}

/**
 * Close a task: the one close-out both `task_step_end outcome=done` and `task_close` share
 * (spec 052, D6/D7).
 *
 * `complete` has two gates, both cheap and both about the *leader's* own state rather than any
 * runtime proof: every DoD item is checked off (the leader's explicit confirmation), and nothing
 * bound to the task is still in flight (otherwise the project would be archived and the late
 * result would fall back into the chat). `cancel` has neither gate — abandoning work must always
 * be possible — but reports what was left running, because closing a task never cancels it.
 */
export async function closeTaskDocument(input: CloseTaskInput): Promise<{ stillRunning: string[] }> {
	const { options, document, id, outcome, note } = input;
	const pending = (await listPendingWork(options, id)).map((item) => item.ref);
	if (outcome === "complete") {
		const unchecked = uncheckedTaskAcceptanceItems(document.body);
		if (unchecked.length > 0) {
			throw new RecoverableToolError(
				`Task "${id}" still has unmet acceptance items: ${unchecked.slice(0, 3).join("; ")}. Check them off with edit once the evidence holds.`,
			);
		}
		if (pending.length > 0) {
			throw new RecoverableToolError(
				`Task "${id}" still has work in flight (${pending.join(", ")}). Wait for it (park on a work ticket), or cancel it with subagent_run / job before finishing.`,
			);
		}
	}
	await input.afterChecks?.();
	const usage = document.fields.usage;
	await appendTaskLog(options.channelDir, id, {
		kind: "close",
		outcome: outcome === "complete" ? "done" : "cancelled",
		note,
		steps: input.steps ?? usage?.steps ?? 0,
		usd: usage?.usd ?? 0,
	});
	await writeStoredTask(document);
	await archiveTask(options.channelDir, id, outcome === "complete" ? "completed" : "cancelled");
	return { stillRunning: outcome === "cancel" ? pending : [] };
}
