import { randomBytes } from "node:crypto";
import type { Executor } from "../sandbox.js";
import { shellEscape } from "../shared/shell-escape.js";

/**
 * Per-channel manager for background bash jobs. A long command that ran synchronously would hold
 * the channel's run queue for its whole duration, blocking `/steer`, `/followup`, and every other
 * message. A background job instead returns immediately; the model can end its turn (freeing the
 * queue) and check back later — typically by scheduling a check-in with `event_manage`, or by
 * calling the `job` tool to poll.
 *
 * Jobs live entirely in the executor's world (host or Docker), managed through shell commands
 * (`nohup` to launch, `kill -0` to probe, `kill` to cancel), so this works identically in both
 * sandboxes with no in-process child handles. Manager state is in-memory and not persisted: after a
 * process restart, prior jobs surface as `lost` rather than being falsely resurrected.
 */

export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "lost";

export interface JobSnapshot {
	id: string;
	label: string;
	command: string;
	status: JobStatus;
	startedAt: number;
	durationMs: number;
	exitCode?: number;
}

interface JobRecord extends JobSnapshot {
	pid: number;
	spillFile: string;
	exitFile: string;
	timeoutSeconds: number;
}

/** Cap on concurrently running jobs per channel, so a runaway model can't spawn unbounded processes. */
export const MAX_RUNNING_JOBS = 5;
/** Longest a single `poll` call blocks before returning a snapshot; the model can poll again. */
export const POLL_WAIT_MS = 30_000;
const POLL_CHECK_INTERVAL_MS = 3_000;

function jobSpillPath(id: string): string {
	return `/tmp/pipiclaw-job-${id}.log`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

function toSnapshot(record: JobRecord): JobSnapshot {
	return {
		id: record.id,
		label: record.label,
		command: record.command,
		status: record.status,
		startedAt: record.startedAt,
		durationMs: (record.status === "running" ? Date.now() : record.durationMs) || Date.now() - record.startedAt,
		exitCode: record.exitCode,
	};
}

export class ChannelJobManager {
	private readonly jobs = new Map<string, JobRecord>();

	constructor(
		private readonly channelId: string,
		private readonly executor: Executor,
	) {}

	get channel(): string {
		return this.channelId;
	}

	runningCount(): number {
		return Array.from(this.jobs.values()).filter((job) => job.status === "running").length;
	}

	/**
	 * Launch a command in the background and return its job id. The wrapper writes merged
	 * stdout/stderr to a spill file and the command's exit code to a sibling `.exit` file, then
	 * `echo $!` hands back the nohup PID for later probing/cancellation.
	 */
	async start(command: string, label: string, timeoutSeconds: number, signal?: AbortSignal): Promise<JobSnapshot> {
		if (this.runningCount() >= MAX_RUNNING_JOBS) {
			throw new Error(
				`Too many background jobs already running (>= ${MAX_RUNNING_JOBS}). Poll or cancel some with the job tool first.`,
			);
		}
		const id = randomBytes(6).toString("hex");
		const spillFile = jobSpillPath(id);
		const exitFile = `${spillFile}.exit`;
		// Run the user command inside a subshell so its own `exit` only leaves the subshell and the
		// exit-capture line still runs; otherwise a command ending in `exit N` would skip it and the
		// job would look `lost` instead of finished.
		const inner = `( ${command} )\n__pc_rc=$?; echo "$__pc_rc" > ${shellEscape(exitFile)}`;
		const launch = `rm -f ${shellEscape(exitFile)}; nohup sh -c ${shellEscape(inner)} > ${shellEscape(spillFile)} 2>&1 & echo $!`;
		const result = await this.executor.exec(launch, { signal });
		const pid = Number.parseInt(result.stdout.trim(), 10);
		if (!Number.isFinite(pid) || pid <= 0) {
			throw new Error(`Failed to start background job: ${result.stderr.trim() || "no PID returned"}`);
		}
		const now = Date.now();
		const record: JobRecord = {
			id,
			label,
			command,
			status: "running",
			startedAt: now,
			durationMs: 0,
			pid,
			spillFile,
			exitFile,
			timeoutSeconds,
		};
		this.jobs.set(id, record);
		return toSnapshot(record);
	}

	/** Refresh the status of a single running job by consulting its `.exit` file and liveness. */
	private async refresh(record: JobRecord, signal?: AbortSignal): Promise<void> {
		if (record.status !== "running") {
			return;
		}
		// Read the exit-code file if present, and separately check whether the PID is still alive.
		const probe = await this.executor.exec(
			`if [ -f ${shellEscape(record.exitFile)} ]; then echo "EXIT:$(cat ${shellEscape(record.exitFile)})"; ` +
				`elif kill -0 ${record.pid} 2>/dev/null; then echo ALIVE; else echo GONE; fi`,
			{ signal },
		);
		const out = probe.stdout.trim();
		if (out.startsWith("EXIT:")) {
			const code = Number.parseInt(out.slice("EXIT:".length).trim(), 10);
			record.exitCode = Number.isFinite(code) ? code : undefined;
			record.status = code === 0 ? "completed" : "failed";
			record.durationMs = Date.now() - record.startedAt;
			return;
		}
		if (out === "GONE") {
			// Process vanished without writing an exit code (killed externally, or manager restarted).
			record.status = "lost";
			record.durationMs = Date.now() - record.startedAt;
			return;
		}
		// Still alive: enforce the wall-clock budget from JS so we do not depend on a `timeout` binary.
		if (Date.now() - record.startedAt > record.timeoutSeconds * 1000) {
			await this.kill(record, signal);
			record.status = "failed";
			record.exitCode = 124;
			record.durationMs = Date.now() - record.startedAt;
		}
	}

	private async kill(record: JobRecord, signal?: AbortSignal): Promise<void> {
		await this.executor
			.exec(`kill ${record.pid} 2>/dev/null; sleep 0.2; kill -9 ${record.pid} 2>/dev/null; true`, { signal })
			.catch(() => {});
	}

	async list(signal?: AbortSignal): Promise<JobSnapshot[]> {
		for (const record of this.jobs.values()) {
			await this.refresh(record, signal);
		}
		return Array.from(this.jobs.values()).map(toSnapshot);
	}

	async cancel(ids: string[], signal?: AbortSignal): Promise<Array<{ id: string; status: JobStatus | "not_found" }>> {
		const results: Array<{ id: string; status: JobStatus | "not_found" }> = [];
		for (const id of ids) {
			const record = this.jobs.get(id);
			if (!record) {
				results.push({ id, status: "not_found" });
				continue;
			}
			await this.refresh(record, signal);
			if (record.status !== "running") {
				results.push({ id, status: record.status });
				continue;
			}
			await this.kill(record, signal);
			record.status = "cancelled";
			record.durationMs = Date.now() - record.startedAt;
			results.push({ id, status: "cancelled" });
		}
		return results;
	}

	/**
	 * Wait until at least one watched job finishes or the wait window elapses, then return a
	 * snapshot. Returns immediately if a watched job is already finished. `ids` omitted watches all
	 * running jobs.
	 */
	async poll(ids: string[] | undefined, signal?: AbortSignal): Promise<JobSnapshot[]> {
		const deadline = Date.now() + POLL_WAIT_MS;
		const watchIds = () =>
			ids && ids.length > 0
				? ids.filter((id) => this.jobs.has(id))
				: Array.from(this.jobs.values())
						.filter((job) => job.status === "running")
						.map((job) => job.id);

		while (true) {
			for (const id of watchIds()) {
				const record = this.jobs.get(id);
				if (record) {
					await this.refresh(record, signal);
				}
			}
			const watched = watchIds()
				.map((id) => this.jobs.get(id))
				.filter((record): record is JobRecord => record !== undefined);
			const anyDone = watched.some((record) => record.status !== "running");
			if (watched.length === 0 || anyDone || Date.now() >= deadline || signal?.aborted) {
				return watched.map(toSnapshot);
			}
			await sleep(POLL_CHECK_INTERVAL_MS, signal);
		}
	}

	/** Read the (possibly truncated) captured output of a finished or running job. */
	async readOutput(id: string, signal?: AbortSignal): Promise<{ spillFile: string; text: string } | undefined> {
		const record = this.jobs.get(id);
		if (!record) {
			return undefined;
		}
		const result = await this.executor.exec(`cat ${shellEscape(record.spillFile)} 2>/dev/null || true`, { signal });
		return { spillFile: record.spillFile, text: result.stdout };
	}
}

// One manager per channel, shared across tool rebuilds so job records survive a resource reload —
// mirrors the shared singletons used elsewhere in the runtime (e.g. the channel memory queue).
const managers = new Map<string, ChannelJobManager>();

export function getChannelJobManager(channelId: string, executor: Executor): ChannelJobManager {
	let manager = managers.get(channelId);
	if (!manager) {
		manager = new ChannelJobManager(channelId, executor);
		managers.set(channelId, manager);
	}
	return manager;
}
