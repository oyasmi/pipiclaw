/**
 * Background-job record vocabulary: status, the snapshot handed to callers, the persisted record
 * and its parser. No state and no I/O, shared by the job manager and its tool/callers (spec 054 D11).
 */
import { isRecord } from "../shared/type-guards.js";

export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface JobSnapshot {
	id: string;
	label: string;
	command: string;
	status: JobStatus;
	startedAt: number;
	durationMs: number;
	exitCode?: number;
	/** The job's own wall-clock limit; a task's `work` ticket derives its backstop from it. */
	timeoutSeconds: number;
	/** The task this job's completion wake belongs to, if any — lets a caller verify that a
	 *  `[JOB:<id>] ... belongs to task <taskId>.` wake actually names the job it claims to (T9). */
	taskId?: string;
}

/** What should happen when the job finishes. */
export interface JobWakeContract {
	/** Wake the channel on completion. Defaults to true — that is the point of the mechanism. */
	notify: boolean;
	/** The task this job is advancing, surfaced in the wake so the model lands in context. */
	taskId?: string;
}

export interface JobRecord extends JobSnapshot {
	pid: number;
	/** Process-group id of the launched job, as `ps` reported it right after spawn. `setsid` makes
	 *  the job its own session/group leader, so this normally equals `pid` — the precondition for a
	 *  safe negative-PGID kill. Absent on records written before this was captured. */
	pgid?: number;
	/** `ps -o lstart=` for `pid` at launch: the only OS-verifiable way to tell the still-running
	 *  job apart from an unrelated process that later reused its pid. Absent on older records and
	 *  whenever `ps` was unavailable at launch — callers must then treat identity as unprovable. */
	pidStartedAt?: string;
	spillFile: string;
	exitFile: string;
	timeoutSeconds: number;
	contract: JobWakeContract;
	/** When the job reached a terminal status; drives retention of the record and spill file. */
	finishedAt?: number;
	/** Set once the completion wake has been dispatched, so a restart cannot re-announce it. */
	notified?: boolean;
	/** Set once the owning task's log has this job's settlement (spec 052, D4); guards against a second record. */
	taskLogged?: boolean;
	/**
	 * A cancel or timeout whose kill could not be *confirmed* yet: the job stays `running` and
	 * manageable, and every sweep re-attempts the kill until the process is proven gone, at which
	 * point this terminal status is applied. Internal only — never surfaced in a `JobSnapshot`.
	 */
	pendingKill?: "cancelled" | "failed";
	wakeClaimDispatchId?: string;
	wakeConsumedAt?: number;
}

export function isTerminal(status: JobStatus): boolean {
	return status !== "running";
}

/** Accept a persisted record only if the fields the manager actually relies on are intact. */
export function parseJobRecord(raw: string): JobRecord | undefined {
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) ||
		typeof value.id !== "string" ||
		typeof value.pid !== "number" ||
		typeof value.spillFile !== "string" ||
		typeof value.exitFile !== "string" ||
		typeof value.startedAt !== "number" ||
		typeof value.timeoutSeconds !== "number" ||
		!isRecord(value.contract)
	) {
		return undefined;
	}
	return value as unknown as JobRecord;
}

export function toSnapshot(record: JobRecord): JobSnapshot {
	return {
		id: record.id,
		label: record.label,
		command: record.command,
		status: record.status,
		startedAt: record.startedAt,
		durationMs: record.status === "running" ? Date.now() - record.startedAt : record.durationMs,
		exitCode: record.exitCode,
		timeoutSeconds: record.timeoutSeconds,
		taskId: record.contract.taskId,
	};
}
