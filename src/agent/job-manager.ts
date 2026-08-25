import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Executor } from "../executor.js";
import { createFileStore, type FileStore } from "../file-store.js";
import * as log from "../log.js";
import type { ChannelEvent } from "../runtime/channel-event.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { shellEscape } from "../shared/shell-escape.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { beginWakeClaim, finishWakeClaim } from "../shared/wake-claim.js";

/**
 * Per-channel manager for background bash jobs. A long command that ran synchronously would hold
 * the channel's run queue for its whole duration, blocking `/steer`, `/followup`, and every other
 * message. A background job instead returns immediately and the model can end its turn.
 *
 * Jobs live on the host, managed through shell commands (`nohup` to launch, `kill -0` to probe,
 * `kill` to cancel) with no in-process child handles. Records are mirrored to
 * `state/jobs/<channelId>/<id>.json` so they survive a restart: a `nohup` process outlives the
 * daemon, and losing the record while the process kept running meant orphaned work, leaked slots,
 * and unreachable output (spec 031, D6).
 *
 * A finished job wakes its channel by itself. Making the model predict a completion time and
 * arrange its own callback was a judgement call it could not make correctly, so completion is a
 * runtime guarantee instead.
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

interface JobRecord extends JobSnapshot {
	pid: number;
	spillFile: string;
	exitFile: string;
	timeoutSeconds: number;
	contract: JobWakeContract;
	/** When the job reached a terminal status; drives retention of the record and spill file. */
	finishedAt?: number;
	/** Set once the completion wake has been dispatched, so a restart cannot re-announce it. */
	notified?: boolean;
	wakeClaimDispatchId?: string;
	wakeConsumedAt?: number;
}

export interface JobStartOptions {
	signal?: AbortSignal;
	notify?: boolean;
	taskId?: string;
}

export interface JobManagerOptions {
	/** Directory for this channel's persisted job records. Omit to run without persistence. */
	stateDir?: string;
	/** Delivers the completion wake. Omit to disable waking (sub-agent and test paths). */
	dispatch?: (event: ChannelEvent) => boolean | Promise<boolean>;
	sweepIntervalMs?: number;
	/** File-content port for reading a job's spill file (spec 044, D8). Defaults to `createFileStore()`. */
	fileStore?: FileStore;
}

/** Cap on concurrently running jobs per channel, so a runaway model can't spawn unbounded processes. */
export const MAX_RUNNING_JOBS = 5;
/** Longest a single `poll` call blocks before returning a snapshot; the model can poll again. */
export const POLL_WAIT_MS = 30_000;
const POLL_CHECK_INTERVAL_MS = 3_000;
/**
 * How often the internal sweeper refreshes running jobs while any are alive. Without it, a job that
 * finishes (or overruns its timeout) is only reaped when the model happens to call list/poll/cancel —
 * so a never-polled job would hold a `MAX_RUNNING_JOBS` slot forever, eventually blocking all `async`.
 * It is also what makes completion wakes timely: the sweep is where a finished job is noticed, and
 * therefore where it announces itself (spec 031, D6, which replaced the earlier "no automatic
 * completion delivery" decision).
 */
export const SWEEP_INTERVAL_MS = 10_000;
/**
 * How long a finished job's record, spill file, and exit file are kept. The model has to be able
 * to read the output after the completion wake, so they cannot be deleted the moment the job ends.
 */
export const FINISHED_JOB_RETENTION_MS = 24 * 60 * 60_000;
/** Bytes of captured output carried inline in the completion wake. */
const WAKE_OUTPUT_TAIL_BYTES = 2_000;
/** Upper bound on how much of a spill file's tail `readOutput` reads (spec 044, D8). */
const JOB_OUTPUT_READ_MAX_BYTES = 512 * 1024;

function jobSpillPath(id: string): string {
	return join(tmpdir(), `pipiclaw-job-${id}.log`);
}

function isTerminal(status: JobStatus): boolean {
	return status !== "running";
}

/** Accept a persisted record only if the fields the manager actually relies on are intact. */
function parseJobRecord(raw: string): JobRecord | undefined {
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
		durationMs: record.status === "running" ? Date.now() - record.startedAt : record.durationMs,
		exitCode: record.exitCode,
		taskId: record.contract.taskId,
	};
}

export class ChannelJobManager {
	private readonly jobs = new Map<string, JobRecord>();
	private readonly wakeQueue = createSerialQueue<string>();
	private sweepTimer?: ReturnType<typeof setInterval>;
	private garbageCollectionTimer?: ReturnType<typeof setTimeout>;
	private sweeping = false;

	private readonly options: JobManagerOptions;
	private readonly sweepIntervalMs: number;
	private readonly fileStore: FileStore;

	constructor(
		private readonly channelId: string,
		private readonly executor: Executor,
		options: JobManagerOptions | number = {},
	) {
		// A bare number keeps the original `sweepIntervalMs` positional form working for tests.
		this.options = typeof options === "number" ? { sweepIntervalMs: options } : options;
		this.sweepIntervalMs = this.options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
		this.fileStore = this.options.fileStore ?? createFileStore();
	}

	private recordPath(id: string): string | undefined {
		return this.options.stateDir ? join(this.options.stateDir, `${id}.json`) : undefined;
	}

	/** Mirror a record to disk. Persistence is best-effort: it must never fail a job operation. */
	private async persist(record: JobRecord, required = false): Promise<void> {
		const path = this.recordPath(record.id);
		if (!path) return;
		try {
			await writeFileAtomically(path, `${JSON.stringify(record)}\n`);
			// The record carries the full command line, so keep it owner-only.
			await chmod(path, 0o600).catch(() => undefined);
		} catch (error) {
			if (required) throw error;
			log.logWarning(`Failed to persist background job ${record.id}`, errorMessage(error));
		}
	}

	private async forget(record: JobRecord): Promise<void> {
		this.jobs.delete(record.id);
		const path = this.recordPath(record.id);
		await Promise.all(
			[path, record.spillFile, record.exitFile]
				.filter((target): target is string => Boolean(target))
				.map((target) => unlink(target).catch(() => undefined)),
		);
	}

	/**
	 * Drop finished jobs whose retention window has passed, together with their spill files.
	 * Called from the sweeper and from restore, so leftovers never outlive a daemon restart.
	 */
	private async collectGarbage(now = Date.now()): Promise<void> {
		for (const record of Array.from(this.jobs.values())) {
			if (isTerminal(record.status) && record.finishedAt && now - record.finishedAt >= FINISHED_JOB_RETENTION_MS) {
				await this.forget(record);
			}
		}
	}

	/**
	 * Arrange the next terminal-record cleanup independently of future job activity. A repeating
	 * sweeper is necessary while processes are running; after that, one unref'ed timeout is enough
	 * to enforce the retention promise without keeping an idle channel awake every few seconds.
	 */
	private scheduleGarbageCollection(): void {
		if (this.garbageCollectionTimer) {
			clearTimeout(this.garbageCollectionTimer);
			this.garbageCollectionTimer = undefined;
		}
		const now = Date.now();
		const nextExpiry = Array.from(this.jobs.values())
			.filter((record) => isTerminal(record.status) && record.finishedAt)
			.map((record) => record.finishedAt! + FINISHED_JOB_RETENTION_MS)
			.reduce<number | undefined>(
				(earliest, expiry) => (earliest === undefined ? expiry : Math.min(earliest, expiry)),
				undefined,
			);
		if (nextExpiry === undefined) {
			return;
		}
		this.garbageCollectionTimer = setTimeout(
			() => {
				this.garbageCollectionTimer = undefined;
				void this.collectGarbage().finally(() => this.scheduleGarbageCollection());
			},
			Math.max(0, nextExpiry - now),
		);
		this.garbageCollectionTimer.unref?.();
	}

	get channel(): string {
		return this.channelId;
	}

	runningCount(): number {
		return Array.from(this.jobs.values()).filter((job) => job.status === "running").length;
	}

	listRunning(): JobRecord[] {
		return Array.from(this.jobs.values()).filter((job) => job.status === "running");
	}

	/** Task ids that a still-running job on this channel promises to wake. See `channelJobTaskIds`. */
	runningTaskIds(): Set<string> {
		const ids = new Set<string>();
		for (const job of this.jobs.values()) {
			if (job.status === "running" && job.contract.notify && job.contract.taskId) {
				ids.add(job.contract.taskId);
			}
		}
		return ids;
	}

	/**
	 * Launch a command in the background and return its job id. The wrapper writes merged
	 * stdout/stderr to a spill file and the command's exit code to a sibling `.exit` file, then
	 * `echo $!` hands back the nohup PID for later probing/cancellation.
	 */
	async start(
		command: string,
		label: string,
		timeoutSeconds: number,
		options: JobStartOptions = {},
	): Promise<JobSnapshot> {
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
		// `umask 077` first: the spill file holds whatever the command printed, which routinely
		// includes credentials, and it is created in a world-readable /tmp. Setting the mask rather
		// than chmod-ing afterwards leaves no window where the file is readable by others.
		const launch =
			`umask 077; rm -f ${shellEscape(exitFile)}; ` +
			`nohup sh -c ${shellEscape(inner)} > ${shellEscape(spillFile)} 2>&1 & echo $!`;
		const result = await this.executor.exec(launch, { signal: options.signal });
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
			contract: { notify: options.notify ?? true, ...(options.taskId ? { taskId: options.taskId } : {}) },
		};
		this.jobs.set(id, record);
		await this.persist(record);
		this.ensureSweeper();
		return toSnapshot(record);
	}

	/**
	 * Start the low-frequency sweeper if it is not already running. It reaps finished/timed-out jobs
	 * so their slots free up even when the model never polls, and stops itself once nothing is running.
	 */
	private ensureSweeper(): void {
		if (this.sweepTimer || this.runningCount() === 0) {
			return;
		}
		this.sweepTimer = setInterval(() => {
			void this.sweep();
		}, this.sweepIntervalMs);
		// Do not keep the process alive just for the sweeper.
		this.sweepTimer.unref?.();
	}

	private stopSweeper(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	private async sweep(): Promise<void> {
		if (this.sweeping) {
			return; // A prior sweep is still awaiting the executor; skip this tick.
		}
		this.sweeping = true;
		try {
			const running = Array.from(this.jobs.values()).filter((record) => record.status === "running");
			// One shell for the whole sweep, not one per job: the sweeper runs every 10s for as
			// long as any job lives, so per-job spawns are the steady-state cost of backgrounding.
			const probes = await this.probeAll(running);
			for (const record of running) {
				await this.applyProbe(record, probes.get(record.id) ?? "").catch((error) => {
					log.logWarning(`Background job sweep failed to refresh job ${record.id}`, errorMessage(error));
				});
			}
			await this.collectGarbage();
		} finally {
			this.sweeping = false;
			if (this.runningCount() === 0) {
				this.stopSweeper();
			}
		}
	}

	/**
	 * Probe every given job in one shell invocation, returning `id → EXIT:<code>|ALIVE|GONE`.
	 *
	 * Each job contributes one branch that reads its exit-code file if present and otherwise checks
	 * PID liveness — exactly what the single-job probe did, just batched.
	 */
	private async probeAll(records: JobRecord[], signal?: AbortSignal): Promise<Map<string, string>> {
		const states = new Map<string, string>();
		if (records.length === 0) {
			return states;
		}
		const script = records
			.map((record) => {
				const id = shellEscape(record.id);
				const exitFile = shellEscape(record.exitFile);
				return (
					`if [ -f ${exitFile} ]; then printf '%s EXIT:%s\\n' ${id} "$(cat ${exitFile})"; ` +
					`elif kill -0 ${record.pid} 2>/dev/null; then printf '%s ALIVE\\n' ${id}; ` +
					`else printf '%s GONE\\n' ${id}; fi`
				);
			})
			.join("\n");
		const probe = await this.executor.exec(script, { signal });
		for (const line of probe.stdout.split("\n")) {
			const separator = line.indexOf(" ");
			if (separator <= 0) continue;
			states.set(line.slice(0, separator), line.slice(separator + 1).trim());
		}
		return states;
	}

	/**
	 * Refresh the status of a single running job by consulting its `.exit` file and liveness.
	 *
	 * `announce` is false only on the `poll` path, which hands the model the finished job's output
	 * inline: waking the channel for a result the model is already holding would burn a whole turn
	 * to say nothing.
	 */
	private async refresh(record: JobRecord, signal?: AbortSignal, announce = true): Promise<void> {
		if (record.status !== "running") {
			return;
		}
		const probes = await this.probeAll([record], signal);
		await this.applyProbe(record, probes.get(record.id) ?? "", signal, announce);
	}

	/** Turn one probe result into a status transition; an unrecognized result only ages the job. */
	private async applyProbe(record: JobRecord, out: string, signal?: AbortSignal, announce = true): Promise<void> {
		if (record.status !== "running") {
			return;
		}
		if (out.startsWith("EXIT:")) {
			const code = Number.parseInt(out.slice("EXIT:".length).trim(), 10);
			record.exitCode = Number.isFinite(code) ? code : undefined;
			await this.finish(record, code === 0 ? "completed" : "failed", signal, announce);
			return;
		}
		if (out === "GONE") {
			// Process vanished without writing an exit code (killed externally, or the host rebooted).
			await this.finish(record, "lost", signal, announce);
			return;
		}
		// Still alive: enforce the wall-clock budget from JS so we do not depend on a `timeout` binary.
		if (Date.now() - record.startedAt > record.timeoutSeconds * 1000) {
			await this.kill(record, signal);
			record.exitCode = 124;
			await this.finish(record, "failed", signal, announce);
		}
	}

	/** Move a job to a terminal status: record it, persist it, and wake the channel once. */
	private async finish(record: JobRecord, status: JobStatus, signal?: AbortSignal, announce = true): Promise<void> {
		record.status = status;
		record.durationMs = Date.now() - record.startedAt;
		record.finishedAt = Date.now();
		if (!announce) {
			// The caller is delivering this result to the model right now; mark it announced so no
			// later sweep re-reports it.
			record.notified = true;
		}
		await this.persist(record);
		await this.announce(record, signal);
		this.scheduleGarbageCollection();
	}

	/**
	 * Wake the channel for a finished job. `dispatch()` durably persists its own pending record
	 * (and is idempotent on dispatch id) before this call can be interrupted, so it is safe to call
	 * again after a crash; `notified` is only persisted *after* it returns, so a crash between the
	 * two can only cause a redelivery, never a lost wake (spec 040, D7 — this reorders a prior
	 * version that persisted `notified` first, which could crash-lose the wake entirely).
	 */
	private async announce(record: JobRecord, signal?: AbortSignal): Promise<void> {
		if (!this.options.dispatch || !record.contract.notify || record.notified) {
			return;
		}

		const output = await this.readOutput(record.id, signal);
		const tail = output?.text.slice(-WAKE_OUTPUT_TAIL_BYTES).trim();
		const exit = record.exitCode !== undefined ? `exit ${record.exitCode}` : record.status;
		const seconds = Math.round(record.durationMs / 1000);
		const belongsTo = record.contract.taskId ? ` It belongs to task ${record.contract.taskId}.` : "";
		const event: ChannelEvent = {
			type: this.channelId.startsWith("group_") ? "group" : "dm",
			channelId: this.channelId,
			user: "JOB",
			userName: "JOB",
			text:
				`[JOB:${record.id}] Background job "${record.label}" finished: ${record.status} (${exit}, ${seconds}s).${belongsTo} ` +
				`Command: ${record.command}\n` +
				`Output tail:\n${tail || "(no output)"}\n` +
				`Full output: ${record.spillFile}\n` +
				"Continue whatever was waiting on this job. If it needs no follow-up, respond with exactly [SILENT].",
			ts: String(Date.now()),
			conversationType: this.channelId.startsWith("group_") ? "2" : "1",
			dispatchId: `job:${this.channelId}:${record.id}:done`,
			...(record.contract.taskId
				? {
						internalWake: {
							kind: "job" as const,
							resourceId: record.id,
							taskId: record.contract.taskId,
							dispatchId: `job:${this.channelId}:${record.id}:done`,
						},
					}
				: {}),
		};
		try {
			await this.options.dispatch(event);
		} catch (error) {
			log.logWarning(`Failed to dispatch completion wake for job ${record.id}`, errorMessage(error));
			return;
		}
		record.notified = true;
		await this.persist(record);
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

	async beginWakeConsumption(id: string, taskId: string, dispatchId: string): Promise<boolean> {
		return this.wakeQueue.run(id, async () => {
			const record = this.jobs.get(id);
			const expected = `job:${this.channelId}:${id}:done`;
			if (!record) return false;
			const eligible = record.status !== "running" && record.contract.taskId === taskId && dispatchId === expected;
			const previousClaim = record.wakeClaimDispatchId;
			if (!beginWakeClaim(record, eligible, dispatchId)) return false;
			try {
				await this.persist(record, true);
			} catch (error) {
				record.wakeClaimDispatchId = previousClaim;
				throw error;
			}
			return true;
		});
	}

	async finishWakeConsumption(id: string, dispatchId: string): Promise<void> {
		await this.wakeQueue.run(id, async () => {
			const record = this.jobs.get(id);
			if (!record || !finishWakeClaim(record, dispatchId)) return;
			try {
				await this.persist(record, true);
			} catch (error) {
				record.wakeConsumedAt = undefined;
				throw error;
			}
		});
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
			// An explicit cancel is the model's own decision, so it needs no wake to learn about it.
			record.contract.notify = false;
			await this.finish(record, "cancelled", signal);
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
					// poll returns the finished job's output to the model inline, so it must not
					// also queue a completion wake for the very same result.
					await this.refresh(record, signal, false);
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

	/**
	 * Rebuild in-memory state from `state/jobs/<channelId>/` after a restart.
	 *
	 * `nohup` processes outlive the daemon, so the records — not the process table — are what was
	 * lost. Re-adopting them makes a still-running job count toward the concurrency cap again,
	 * lets its output be retrieved, and lets its completion wake fire (late, but not never).
	 */
	async restore(signal?: AbortSignal): Promise<number> {
		const stateDir = this.options.stateDir;
		if (!stateDir) return 0;
		let filenames: string[];
		try {
			filenames = (await readdir(stateDir)).filter((name) => name.endsWith(".json"));
		} catch {
			return 0;
		}

		let restored = 0;
		for (const filename of filenames) {
			const path = join(stateDir, filename);
			let record: JobRecord | undefined;
			try {
				record = parseJobRecord(await readFile(path, "utf-8"));
			} catch {
				record = undefined;
			}
			if (!record) {
				log.logWarning(`Discarding unreadable background job record: ${filename}`);
				await unlink(path).catch(() => undefined);
				continue;
			}
			this.jobs.set(record.id, record);
			restored++;
			// One probe decides between "still running", "finished while we were down", and "gone";
			// refresh already encodes all three, including the late completion wake.
			await this.refresh(record, signal).catch((error) => {
				log.logWarning(`Failed to reconcile background job ${record?.id}`, errorMessage(error));
			});
		}

		await this.collectGarbage();
		this.scheduleGarbageCollection();
		this.ensureSweeper();
		return restored;
	}

	/** Read the (possibly truncated) captured output of a finished or running job. */
	async readOutput(id: string, signal?: AbortSignal): Promise<{ spillFile: string; text: string } | undefined> {
		const record = this.jobs.get(id);
		if (!record) {
			return undefined;
		}
		// Both callers (the completion wake and the `job` tool) only ever want the *tail* of a job's
		// output, so read it via `FileStore` straight from the end of the file rather than shelling
		// out to `cat` (spec 044, D8) -- no 10MB shell-capture cap silently eating the head of a long
		// job's output before the tail-truncation logic even runs, and no subprocess for what's a
		// plain local-file read.
		const stat = await this.fileStore.stat(record.spillFile);
		if (!stat) {
			return { spillFile: record.spillFile, text: "" };
		}
		const start = Math.max(0, stat.size - JOB_OUTPUT_READ_MAX_BYTES);
		const { data } = await this.fileStore.readBytes(record.spillFile, { start, signal });
		const text = start > 0 ? `[...output truncated...]\n${data.toString("utf-8")}` : data.toString("utf-8");
		return { spillFile: record.spillFile, text };
	}
}

// One manager per channel, shared across tool rebuilds so job records survive a resource reload —
// mirrors the shared singletons used elsewhere in the runtime (e.g. the channel memory queue).
const managers = new Map<string, ChannelJobManager>();

interface JobRuntimeConfig {
	/** Root of the per-channel record directories (`<jobsStateDir>/<channelId>/`). */
	jobsStateDir?: string;
	dispatch?: (event: ChannelEvent) => boolean | Promise<boolean>;
}

let runtimeConfig: JobRuntimeConfig = {};

/**
 * Give background jobs their persistence root and their way to wake a channel. Called once from
 * bootstrap, before any turn runs; the tool layer builds managers lazily and picks this up.
 */
export function configureJobRuntime(config: JobRuntimeConfig): void {
	runtimeConfig = config;
}

/**
 * Which of this channel's tasks a running background job will wake, without needing an `Executor`.
 *
 * Read-only view for `/tasks doctor`: a parked task (`waiting`, no `wake`) is healthy exactly when
 * something is going to call it. Managers are created lazily by the tool layer *and* eagerly at
 * startup by `restoreChannelJobs`, so a channel with live jobs always has one; a channel with no
 * manager simply has no jobs, and the empty set is the right answer.
 */
export function channelJobTaskIds(channelId: string): Set<string> {
	return managers.get(channelId)?.runningTaskIds() ?? new Set<string>();
}

/**
 * Human-readable lines naming this channel's currently running background jobs, for the `/project
 * set|reset` blocker check (spec 043, D4.3) — mirrors `channelJobTaskIds`'s "no manager means no
 * jobs" reasoning, so it needs no `Executor` either.
 */
export function channelRunningJobLines(channelId: string): string[] {
	const manager = managers.get(channelId);
	if (!manager) return [];
	return manager.listRunning().map((job) => `job \`${job.id}\`: ${job.command.slice(0, 80)}`);
}

export function getChannelJobManager(channelId: string, executor: Executor): ChannelJobManager {
	let manager = managers.get(channelId);
	if (!manager) {
		manager = new ChannelJobManager(channelId, executor, {
			...(runtimeConfig.jobsStateDir ? { stateDir: join(runtimeConfig.jobsStateDir, channelId) } : {}),
			...(runtimeConfig.dispatch ? { dispatch: runtimeConfig.dispatch } : {}),
		});
		managers.set(channelId, manager);
	}
	return manager;
}

/**
 * Re-adopt every channel's persisted jobs at startup. Channels are discovered from the state
 * directory itself, so a job survives even when its channel has had no traffic since the restart.
 */
export async function restoreChannelJobs(executor: Executor): Promise<number> {
	const jobsStateDir = runtimeConfig.jobsStateDir;
	if (!jobsStateDir) return 0;
	let channelIds: string[];
	try {
		await mkdir(jobsStateDir, { recursive: true });
		channelIds = (await readdir(jobsStateDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		log.logWarning("Failed to scan persisted background jobs", errorMessage(error));
		return 0;
	}

	let restored = 0;
	for (const channelId of channelIds) {
		restored += await getChannelJobManager(channelId, executor).restore();
	}
	if (restored > 0) {
		log.logInfo(`Restored ${restored} background job record(s)`);
	}
	return restored;
}
