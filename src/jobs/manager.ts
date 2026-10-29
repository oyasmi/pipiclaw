import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WakeEvent } from "../channel/channel-event.js";
import { getDeskDir, getDeskLogsDir, isDeskName } from "../desk/paths.js";
import type { ExecResult, Executor } from "../executor.js";
import { createFileStore, type FileStore } from "../file-store.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { shellEscape } from "../shared/os.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { logTaskDispatch, logTaskSettlement } from "../tasks/bound-work.js";
import { readStoredTask } from "../tasks/store.js";
import { buildJobCompletionWake } from "./completion-wake.js";
import { buildLaunchScript, type JobArtifacts, jobArtifacts, parseLaunchOutput } from "./launch.js";
import { isTerminal, type JobRecord, type JobSnapshot, type JobStatus, parseJobRecord, toSnapshot } from "./record.js";

/**
 * Per-desk manager for background bash jobs. A long command that ran synchronously would hold
 * the channel's run queue for its whole duration, blocking `/steer`, `/followup`, and every other
 * message. A background job instead returns immediately and the model can end its turn.
 *
 * Jobs live on the host, managed through shell commands (`setsid` to launch as its own process
 * group with a startup handshake, a three-state identity probe, a confirmed kill) with no
 * in-process child handles. Records
 * are mirrored to `state/jobs/<desk>/<id>.json` so they survive a restart: a detached
 * process outlives the daemon, and losing the record while the process kept running meant orphaned
 * work, leaked slots, and unreachable output (spec 031, D6).
 *
 * A finished job wakes its channel by itself. Making the model predict a completion time and
 * arrange its own callback was a judgement call it could not make correctly, so completion is a
 * runtime guarantee instead.
 */

/**
 * The outcome of one kill attempt, decided from the kill script's own printed token plus the
 * executor result — never from "the shell exited 0", which a failed `kill` inside `2>/dev/null`
 * would still do.
 * - `terminated` — we signalled the target and then confirmed the pid is gone.
 * - `gone` — the target was already gone before we signalled (or its pgid became unroutable).
 * - `identity-mismatch` — the pid now belongs to an unrelated process, so *our* process is gone.
 * - `unconfirmed` — the kill ran but the pid is still alive afterwards.
 * - `not-submitted` — the executor could not even run the kill.
 * - `no-target` — there is no pid we can safely signal (pid <= 1 / not finite).
 */
type KillOutcome = "terminated" | "gone" | "identity-mismatch" | "unconfirmed" | "not-submitted" | "no-target";

/** Outcomes that prove the job's process is gone — safe to apply a terminal status. */
const KILL_CONFIRMED_GONE: ReadonlySet<KillOutcome> = new Set<KillOutcome>([
	"terminated",
	"gone",
	"identity-mismatch",
	"no-target",
]);

export interface JobStartOptions {
	/** The channel the job was started from: its completion wake goes back there (spec 058, D7). */
	channelId: string;
	signal?: AbortSignal;
	notify?: boolean;
	/** The task whose step starts the job (spec 064, INV-8): its completion is recorded there instead of waking `channelId`. */
	taskId?: string;
}

export interface JobManagerOptions {
	/** Directory for this desk's persisted job records. Omit to run without persistence. */
	stateDir?: string;
	/** Is a job's channel still bound to this desk (spec 058, D7)? Omitted (TUI, tests): always. */
	isBoundTo?: (channelId: string, desk: string) => boolean;
	/** Delivers the completion wake. Omit to disable waking (sub-agent and test paths). */
	dispatch?: (event: WakeEvent) => boolean | Promise<boolean>;
	/** A task-bound job settled and its record is in the task's log; the lane recomputes from it (spec 064, D19). */
	onTaskInput?: (desk: string, taskId: string) => void;
	sweepIntervalMs?: number;
	/** File-content port for reading a job's spill file (spec 044, D8). Defaults to `createFileStore()`. */
	fileStore?: FileStore;
	/** Directory the full-output spill (and its `.exit`/`.ready`/`.meta` siblings) is written to.
	 * Defaults to the OS temp dir; the runtime passes `<deskDir>/logs` so the model can read it. */
	spillDir?: string;
}

/** Cap on concurrently running jobs per desk, so a runaway model can't spawn unbounded processes. */
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

function jobSpillPath(id: string, spillDir?: string): string {
	return join(spillDir ?? tmpdir(), `pipiclaw-job-${id}.log`);
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

export class DeskJobManager {
	private readonly jobs = new Map<string, JobRecord>();
	/**
	 * Serializes every probe → decide → terminal-transition sequence for a single job. The sweeper,
	 * `list`/`poll`/`restore` (via `refresh`), `cancel`, and the persist-failure rollback all pass
	 * through it, so two callers can never race the same job to two terminal states (e.g. both see
	 * `pendingKill`, both `finish`, the second reading a now-cleared `pendingKill` and writing a
	 * bogus status). Inside the slot each op re-checks `record.status`.
	 */
	private readonly reconcileQueue = createSerialQueue<string>();
	private sweepTimer?: ReturnType<typeof setInterval>;
	private garbageCollectionTimer?: ReturnType<typeof setTimeout>;
	private sweeping = false;
	private stopped = false;

	private readonly options: JobManagerOptions;
	private readonly sweepIntervalMs: number;
	private readonly fileStore: FileStore;

	/** `target` owns these jobs (task logs live in its directory); each job's own channel gets its wake. */
	constructor(
		private readonly target: { desk: string; deskDir?: string },
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
			log.logWarn("job.persist.failed", "Background job persist failed", {
				reason: errorMessage(error),
				fields: { jobId: record.id },
			});
		}
	}

	private async forget(record: JobRecord): Promise<void> {
		this.jobs.delete(record.id);
		const art = jobArtifacts(record.spillFile);
		await this.unlinkArtifacts(art, this.recordPath(record.id));
	}

	/** Remove a job's scratch files (and optionally its persisted record). Every unlink is best-effort. */
	private async unlinkArtifacts(art: JobArtifacts, recordPath?: string): Promise<void> {
		const targets = [
			recordPath,
			art.spillFile,
			art.exitFile,
			art.exitTmp,
			art.readyFile,
			art.readyTmp,
			art.metaFile,
			art.metaTmp,
		];
		await Promise.all(
			targets
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
			if (
				isTerminal(record.status) &&
				(!record.contract.taskId || record.taskLogged) &&
				record.finishedAt &&
				now - record.finishedAt >= FINISHED_JOB_RETENTION_MS
			) {
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
		if (this.stopped) return;
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

	runningCount(): number {
		return Array.from(this.jobs.values()).filter((job) => job.status === "running").length;
	}

	listRunning(): JobRecord[] {
		return Array.from(this.jobs.values()).filter((job) => job.status === "running");
	}

	/**
	 * Launch a command in the background and return its snapshot. The wrapper (`buildLaunchScript`)
	 * runs a readiness handshake before the command executes: only after the inner shell proves it
	 * started — spill writable, `setsid`/`sh` execed — does the parent print `MODE`/`PID` and exit
	 * 0. A failed handshake, a non-zero launch, or an interrupted launch never creates a `running`
	 * record; a persist failure right after a successful launch terminates the process (see below).
	 */
	async start(command: string, label: string, timeoutSeconds: number, options: JobStartOptions): Promise<JobSnapshot> {
		if (this.runningCount() >= MAX_RUNNING_JOBS) {
			throw new Error(
				`Too many background jobs already running (>= ${MAX_RUNNING_JOBS}). Poll or cancel some with the job tool first.`,
			);
		}
		const id = randomBytes(6).toString("hex");
		if (this.options.spillDir) {
			await mkdir(this.options.spillDir, { recursive: true }).catch(() => undefined);
		}
		const spillFile = jobSpillPath(id, this.options.spillDir);
		const art = jobArtifacts(spillFile);
		const launch = buildLaunchScript(command, art);

		let result: ExecResult;
		try {
			result = await this.executor.exec(launch, { signal: options.signal });
		} catch (error) {
			// The launch was aborted (or the executor could not run it). A detached child may
			// already be running — try to recover its pid and clean it up honestly.
			throw await this.recoverInterruptedLaunch(art, error);
		}

		const launched = parseLaunchOutput(result.stdout);
		if (result.code !== 0 || launched.handshakeFailed) {
			// The wrapper's readiness handshake never completed: the inner shell could not start
			// (spill unwritable, `setsid`/`sh` exec failure, …). It has already killed whatever it
			// spawned; drop the scratch files and surface the inner error.
			await this.unlinkArtifacts(art);
			const detail =
				result.stdout
					.split("\n")
					.filter(
						(line) =>
							line.trim() &&
							!/^(MODE|PID|PGID|LSTART|HANDSHAKE) /.test(line) &&
							line.trim() !== "HANDSHAKE failed",
					)
					.join(" ")
					.trim() || result.stderr.trim();
			throw new Error(
				`Failed to start background job "${label}"${detail ? `: ${detail}` : " — launch handshake did not complete"}`,
			);
		}

		const pid = launched.pid;
		if (pid === undefined || !Number.isFinite(pid) || pid <= 0) {
			await this.unlinkArtifacts(art);
			throw new Error(`Failed to start background job "${label}": ${result.stderr.trim() || "no PID returned"}`);
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
			...(launched.pgid !== undefined ? { pgid: launched.pgid } : {}),
			...(launched.pidStartedAt ? { pidStartedAt: launched.pidStartedAt } : {}),
			spillFile,
			exitFile: art.exitFile,
			timeoutSeconds,
			contract: { notify: options.notify ?? true, ...(options.taskId ? { taskId: options.taskId } : {}) },
			channelId: options.channelId,
		};
		this.jobs.set(id, record);
		// The persisted record is the only thing that survives a restart — a detached process
		// outlives the daemon, and losing its record means an orphan holding a slot with unreachable
		// output. So the first persist is required: if it fails, terminate what we just launched and
		// surface the failure instead of returning a job the caller can never recover (T1).
		try {
			await this.persist(record, true);
		} catch (error) {
			// The rollback kill + bookkeeping run inside the job's reconcile slot so a sweeper tick
			// that has already adopted this record cannot transition it underneath us. Cleanup must
			// not inherit the caller's AbortSignal (it may already be aborted).
			const reason = `its record could not be persisted (${errorMessage(error)})`;
			const failure = await this.reconcileQueue.run(id, async (): Promise<Error> => {
				const outcome = await this.runKill(record);
				if (!KILL_CONFIRMED_GONE.has(outcome)) {
					// The process could not be confirmed gone (kill unconfirmed, or the executor could
					// not run it). Deleting the only trace of a live process is exactly the orphan this
					// path exists to prevent — keep the in-memory record manageable so the sweeper keeps
					// trying, and say so plainly.
					record.pendingKill = "cancelled";
					this.ensureSweeper();
					return new Error(
						`Background job started but ${reason}; its process (pid ${pid}) could not be confirmed terminated. ` +
							`The job is left tracked in memory (id ${id}) so the sweeper keeps retrying — cancel it once the executor recovers. No record was persisted.`,
					);
				}
				this.jobs.delete(id);
				await this.forget(record).catch(() => undefined);
				const tail = outcome === "terminated" ? "its process was terminated" : "its process was already gone";
				return new Error(`Background job started but ${reason}; ${tail}. No job was created.`);
			});
			throw failure;
		}
		if (options.taskId && this.target.deskDir) {
			await logTaskDispatch(this.target.deskDir, options.taskId, {
				ref: id,
				agent: "job",
				label,
			}).catch((error) => {
				log.logWarn("job.task_dispatch.log_failed", "Task dispatch record failed", {
					reason: errorMessage(error),
					fields: { jobId: id, taskId: options.taskId },
				});
			});
		}
		this.ensureSweeper();
		return toSnapshot(record);
	}

	/**
	 * Recover from a launch that rejected (an abort landed after the wrapper had already spawned the
	 * detached child, or the executor failed outright). The wrapper writes a metadata file *before*
	 * its readiness handshake, so even an interrupted launch usually leaves a recoverable pid;
	 * clean it up with no caller signal and return an error that is honest about what is known.
	 */
	private async recoverInterruptedLaunch(art: JobArtifacts, error: unknown): Promise<Error> {
		const cause = errorMessage(error);
		const partialStdout =
			typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
		let launched = parseLaunchOutput(partialStdout);
		for (const metaPath of [art.metaFile, art.metaTmp]) {
			if (launched.pid !== undefined) break;
			try {
				launched = parseLaunchOutput(await readFile(metaPath, "utf-8"));
			} catch {
				// no metadata at this path
			}
		}

		const pid = launched.pid;
		if (pid === undefined || !Number.isFinite(pid) || pid <= 0) {
			await this.unlinkArtifacts(art);
			return new Error(
				`Background job launch was interrupted (${cause}); no pid could be recovered, so whether the command actually started cannot be confirmed. No job was created.`,
			);
		}

		const provisional: Pick<JobRecord, "pid" | "pgid" | "pidStartedAt"> = {
			pid,
			...(launched.pgid !== undefined ? { pgid: launched.pgid } : {}),
			...(launched.pidStartedAt ? { pidStartedAt: launched.pidStartedAt } : {}),
		};
		const outcome = await this.runKill(provisional); // deliberately no signal
		await this.unlinkArtifacts(art);
		const tail = KILL_CONFIRMED_GONE.has(outcome)
			? outcome === "terminated"
				? `its process (pid ${pid}) was terminated`
				: `its process (pid ${pid}) was already gone`
			: `termination of its process (pid ${pid}) could not be confirmed — verify it manually`;
		return new Error(`Background job launch was interrupted (${cause}); recovered and ${tail}. No job was created.`);
	}

	/**
	 * Start the low-frequency sweeper if it is not already running. It reaps finished/timed-out jobs
	 * so their slots free up even when the model never polls, and stops itself once nothing is running.
	 */
	private ensureSweeper(): void {
		if (this.stopped || this.sweepTimer || this.runningCount() === 0) {
			return;
		}
		this.sweepTimer = setInterval(() => {
			// A timer callback is the last frame that can hold this promise: an unhandled
			// rejection here (a probe that cannot spawn — EAGAIN/EMFILE/ENOMEM) exits the
			// whole daemon, since nothing installs a process-level rejection handler.
			this.sweep().catch((error) => {
				log.logWarn("job.sweep.failed", "Background job sweep failed", { reason: errorMessage(error) });
			});
		}, this.sweepIntervalMs);
		// Do not keep the process alive just for the sweeper.
		this.sweepTimer.unref?.();
	}

	/** Stop observation at application shutdown; detached jobs keep running. */
	stop(): void {
		this.stopped = true;
		this.stopSweeper();
		if (this.garbageCollectionTimer) clearTimeout(this.garbageCollectionTimer);
		this.garbageCollectionTimer = undefined;
	}

	private stopSweeper(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = undefined;
		}
	}

	private async sweep(): Promise<void> {
		if (this.stopped || this.sweeping) {
			return; // A prior sweep is still awaiting the executor; skip this tick.
		}
		this.sweeping = true;
		try {
			const running = Array.from(this.jobs.values()).filter((record) => record.status === "running");
			// One shell for the whole sweep, not one per job: the sweeper runs every 10s for as
			// long as any job lives, so per-job spawns are the steady-state cost of backgrounding.
			const probes = await this.probeAll(running);
			for (const record of running) {
				// The batched probe is a read; the state transition it implies still goes through the
				// per-job slot so it cannot race a concurrent list/poll/cancel.
				await this.reconcileQueue
					.run(record.id, async () => {
						if (this.stopped || record.status !== "running") return;
						await this.applyProbe(record, probes.get(record.id) ?? "");
					})
					.catch((error) => {
						log.logWarn("job.sweep.refresh_failed", "Background job refresh failed", {
							reason: errorMessage(error),
							fields: { jobId: record.id },
						});
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
	 * Probe every given job in one shell invocation, returning
	 * `id → EXIT:<code> | ALIVE | GONE | DIFFERENT | UNKNOWN`.
	 *
	 * Each job contributes one branch that reads its exit-code file if present and otherwise checks
	 * liveness (three-state when a start time was captured — see the inline comment).
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
				// Liveness: when the job's start time was captured, require the pid to still report
				// that exact `ps -o lstart=` — a recycled pid then reads as GONE, not ALIVE, so the
				// manager never mistakes an unrelated process for the job. Older records without a
				// captured start time fall back to a bare `kill -0`, the best they can do.
				// `-s`, not `-f`: an existing-but-empty `.exit` file (a torn write) must not count as
				// a finished job. The writer renames a fully-written temp file into place, so `-s`
				// here only ever sees the settled value (T4).
				//
				// Identity liveness is three-state: with a captured start time, `ps` reporting the
				// *same* lstart is ALIVE, a *different* one is DIFFERENT (pid recycled — our process
				// is gone), and `ps` returning nothing while `kill -0` still says alive is UNKNOWN
				// (do not conclude anything — a later probe retries). Legacy records have only
				// `kill -0`: ALIVE / GONE.
				const liveness = record.pidStartedAt
					? `__pc_cur="$(ps -o lstart= -p ${record.pid} 2>/dev/null)"; ` +
						`if [ -z "$__pc_cur" ]; then ` +
						`if kill -0 ${record.pid} 2>/dev/null; then printf '%s UNKNOWN\\n' ${id}; else printf '%s GONE\\n' ${id}; fi; ` +
						`elif [ "$__pc_cur" = ${shellEscape(record.pidStartedAt)} ]; then printf '%s ALIVE\\n' ${id}; ` +
						`else printf '%s DIFFERENT\\n' ${id}; fi`
					: `if kill -0 ${record.pid} 2>/dev/null; then printf '%s ALIVE\\n' ${id}; else printf '%s GONE\\n' ${id}; fi`;
				return `if [ -s ${exitFile} ]; then printf '%s EXIT:%s\\n' ${id} "$(cat ${exitFile})"; else ${liveness}; fi`;
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
		await this.reconcileQueue.run(record.id, () => this.reconcileLocked(record, signal, announce));
	}

	/**
	 * Probe one job and apply the result. The unlocked core of `refresh` — every caller must already
	 * hold the job's `reconcileQueue` slot (`refresh`, or `cancel`'s combined critical section).
	 */
	private async reconcileLocked(record: JobRecord, signal?: AbortSignal, announce = true): Promise<void> {
		if (record.status !== "running") {
			await this.logSettlementToTask(record);
			await this.announce(record, signal);
			return;
		}
		const probes = await this.probeAll([record], signal);
		await this.applyProbe(record, probes.get(record.id) ?? "", signal, announce);
	}

	/**
	 * The terminal status for a job a probe just showed as finished/gone. A cancel or timeout kill
	 * already in flight (`pendingKill`) wins over the raw probe result — a job the model asked to
	 * cancel lands `cancelled`, a timed-out one `failed`/124 — even if the process happened to exit
	 * on its own first. Clears `pendingKill`; call only immediately before `finish`.
	 */
	private takePendingTerminal(
		record: JobRecord,
		fallbackStatus: JobStatus,
		fallbackExitCode: number | undefined,
	): { status: JobStatus; exitCode: number | undefined } {
		const pending = record.pendingKill;
		record.pendingKill = undefined;
		if (pending === "cancelled") return { status: "cancelled", exitCode: undefined };
		if (pending === "failed") return { status: "failed", exitCode: 124 };
		return { status: fallbackStatus, exitCode: fallbackExitCode };
	}

	/** Turn one probe result into a status transition; an inconclusive result only ages the job. */
	private async applyProbe(record: JobRecord, out: string, signal?: AbortSignal, announce = true): Promise<void> {
		if (record.status !== "running") {
			return;
		}
		if (out.startsWith("EXIT:")) {
			const rawCode = out.slice("EXIT:".length).trim();
			// A present `.exit` file whose contents are not yet a whole integer means the writer is
			// mid-write (or wrote garbage). Do not force a terminal status off it — leave the job
			// running so a later probe can read the settled value; only the checks below still apply.
			if (/^-?\d+$/.test(rawCode)) {
				const code = Number.parseInt(rawCode, 10);
				const t = this.takePendingTerminal(record, code === 0 ? "completed" : "failed", code);
				record.exitCode = t.exitCode;
				await this.finish(record, t.status, signal, announce);
				return;
			}
		} else if (out === "GONE" || out === "DIFFERENT") {
			// GONE: vanished without an exit code (killed externally, host rebooted). DIFFERENT: the
			// pid now belongs to an unrelated process, so ours is definitively gone. Either way the
			// job is over. (`UNKNOWN` deliberately does NOT land here — `ps` being briefly
			// unavailable must not terminalize a live job; a later probe retries.)
			const t = this.takePendingTerminal(record, "lost", undefined);
			record.exitCode = t.exitCode;
			await this.finish(record, t.status, signal, announce);
			return;
		}

		// Still running (ALIVE / UNKNOWN / torn-EXIT). A cancel or timeout whose kill could not be
		// confirmed earlier retries here every sweep until the process is proven gone.
		if (record.pendingKill) {
			const outcome = await this.runKill(record, signal);
			if (record.status === "running" && KILL_CONFIRMED_GONE.has(outcome)) {
				const t = this.takePendingTerminal(record, "lost", undefined);
				record.exitCode = t.exitCode;
				await this.finish(record, t.status, signal, announce);
			}
			return;
		}

		// Wall-clock budget, enforced from JS so we do not depend on a `timeout` binary. Only fall
		// to a terminal status once the kill is confirmed; otherwise mark it pending and keep
		// managing it (the sweeper retries).
		if (Date.now() - record.startedAt > record.timeoutSeconds * 1000) {
			const outcome = await this.runKill(record, signal);
			if (record.status !== "running") return;
			if (KILL_CONFIRMED_GONE.has(outcome)) {
				const t = this.takePendingTerminal(record, "failed", 124);
				record.exitCode = t.exitCode;
				await this.finish(record, t.status, signal, announce);
			} else if (!record.pendingKill) {
				// Kill unconfirmed: keep managing it. A cancel already in flight keeps its intent.
				record.pendingKill = "failed";
				await this.persist(record).catch(() => undefined);
			}
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
		await this.logSettlementToTask(record);
		await this.announce(record, signal);
		this.scheduleGarbageCollection();
	}

	/**
	 * Tell the owning task this job settled (spec 052, D4). Runs before the lane is told, so the step
	 * it starts already finds the result in its inputs. Best-effort and once-only: a task that no
	 * longer exists, or a replayed finish, writes nothing.
	 */
	private async logSettlementToTask(record: JobRecord): Promise<void> {
		const taskId = record.contract.taskId;
		const deskDir = this.target.deskDir;
		if (!taskId || !deskDir || record.taskLogged) return;
		const output = await this.readOutput(record.id).catch(() => undefined);
		await logTaskSettlement(deskDir, taskId, {
			ref: record.id,
			status: record.status,
			exitCode: record.exitCode,
			output: record.spillFile,
			tail: output?.text.slice(-WAKE_OUTPUT_TAIL_BYTES).trim() || undefined,
			durationMs: record.durationMs,
			// The caller delivered this result to the model in the same tool call (`announce: false`).
			...(record.notified ? { inline: true } : {}),
		});
		record.taskLogged = true;
		await this.persist(record);
	}

	/**
	 * Wake the channel for a finished job. `dispatch()` durably persists its own pending record
	 * (and is idempotent on dispatch id) before this call can be interrupted, so it is safe to call
	 * again after a crash; `notified` is only persisted *after* it returns, so a crash between the
	 * two can only cause a redelivery, never a lost wake (spec 040, D7 — this reorders a prior
	 * version that persisted `notified` first, which could crash-lose the wake entirely).
	 */
	private async announce(record: JobRecord, signal?: AbortSignal): Promise<void> {
		if (record.notified) return;
		// A task-bound job reports to its task, not to a channel (spec 064, D19): the settle record
		// is in the task's log, so the lane only has to look. A task that has since vanished has
		// nowhere to read the result, so the job falls back to waking the chat.
		const taskId = record.contract.taskId;
		if (taskId && this.target.deskDir && (await readStoredTask(this.target.deskDir, taskId))) {
			this.options.onTaskInput?.(this.target.desk, taskId);
			record.notified = true;
			await this.persist(record);
			return;
		}
		if (!this.options.dispatch || !record.contract.notify) {
			return;
		}

		const channelId = record.channelId;
		if (this.options.isBoundTo && !this.options.isBoundTo(channelId, this.target.desk)) {
			await this.suppressWake(record);
			return;
		}
		const output = await this.readOutput(record.id, signal);
		const tail = output?.text.slice(-WAKE_OUTPUT_TAIL_BYTES).trim();
		const event = buildJobCompletionWake({ desk: this.target.desk, channelId, record, tail });
		try {
			await this.options.dispatch(event);
		} catch (error) {
			log.logWarn("job.wake.dispatch_failed", "Completion wake dispatch failed", {
				reason: errorMessage(error),
				fields: { jobId: record.id },
			});
			return;
		}
		record.notified = true;
		await this.persist(record);
	}

	/** Same contract as `SubAgentRunManager.suppressWake`: drop the chat wake of a job whose channel left the desk. */
	private async suppressWake(record: JobRecord): Promise<void> {
		log.logInfoEvent("job.wake.suppressed", "Completion wake dropped: channel not bound to the job's desk", {
			channelId: record.channelId,
			fields: { jobId: record.id, desk: this.target.desk },
		});
		record.notified = true;
		await this.persist(record);
	}

	/**
	 * The shell command that terminates `record`'s process and prints one token describing what
	 * happened (`TERMINATED` / `GONE` / `IDENTITY_MISMATCH` / `UNCONFIRMED`), or `undefined` when
	 * there is no pid we can safely signal.
	 *
	 * A negative-PGID target is used only when `setsid` gave the job pgid == pid (spec: everything
	 * the command spawned dies with it). When a start time was captured it is checked first: a
	 * recycled pid reads as `IDENTITY_MISMATCH` and is never signalled; a pid `ps` cannot see but
	 * that `kill -0` says is alive reads as `UNCONFIRMED` (do not signal what we cannot prove is
	 * ours). Legacy / nohup records have only `kill -0` liveness and a plain pid kill.
	 */
	private killCommand(record: Pick<JobRecord, "pid" | "pgid" | "pidStartedAt">): string | undefined {
		const pid = record.pid;
		if (!Number.isFinite(pid) || pid <= 1) return undefined;
		const groupSafe = record.pgid !== undefined && record.pgid === pid;
		const target = groupSafe ? `"-${pid}"` : `${pid}`;
		const gate = record.pidStartedAt
			? `__pc_cur="$(ps -o lstart= -p ${pid} 2>/dev/null)"; ` +
				`if [ -z "$__pc_cur" ]; then ` +
				`if kill -0 ${pid} 2>/dev/null; then printf 'UNCONFIRMED\\n'; exit 0; else printf 'GONE\\n'; exit 0; fi; fi; ` +
				`if [ "$__pc_cur" != ${shellEscape(record.pidStartedAt)} ]; then printf 'IDENTITY_MISMATCH\\n'; exit 0; fi; `
			: `if ! kill -0 ${pid} 2>/dev/null; then printf 'GONE\\n'; exit 0; fi; `;
		return (
			gate +
			`kill -TERM ${target} 2>/dev/null; sleep 0.2; kill -KILL ${target} 2>/dev/null; sleep 0.05; ` +
			`if kill -0 ${pid} 2>/dev/null; then printf 'UNCONFIRMED\\n'; else printf 'TERMINATED\\n'; fi`
		);
	}

	/**
	 * Run one kill attempt and classify it from the printed token plus the executor result — never
	 * from "the shell exited 0". Used by cancel, timeout, the persist-failure rollback and the
	 * interrupted-launch recovery; the last two pass no signal so an aborted caller cannot skip it.
	 */
	private async runKill(
		record: Pick<JobRecord, "pid" | "pgid" | "pidStartedAt">,
		signal?: AbortSignal,
	): Promise<KillOutcome> {
		const command = this.killCommand(record);
		if (!command) return "no-target";
		let result: ExecResult;
		try {
			result = await this.executor.exec(command, signal ? { signal } : {});
		} catch {
			return "not-submitted";
		}
		const token = result.stdout.trim().split("\n").pop()?.trim() ?? "";
		switch (token) {
			case "TERMINATED":
				return "terminated";
			case "GONE":
				return "gone";
			case "IDENTITY_MISMATCH":
				return "identity-mismatch";
			case "UNCONFIRMED":
				return "unconfirmed";
			default:
				return "not-submitted";
		}
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
			// Whole per-job critical section (refresh + kill + transition) under one slot, so the
			// sweeper cannot land a different terminal state on this job while we decide.
			const result = await this.reconcileQueue.run(id, async () => {
				await this.reconcileLocked(record, signal);
				if (record.status !== "running") {
					return { id, status: record.status };
				}
				// An explicit cancel is the model's own decision, so it needs no wake to learn about it.
				record.contract.notify = false;
				const outcome = await this.runKill(record, signal);
				if (KILL_CONFIRMED_GONE.has(outcome)) {
					// A timeout kill already pending (`failed`/124) outranks this cancel — the job did
					// overrun its budget. `takePendingTerminal` applies that precedence and only falls
					// back to `cancelled` when nothing was pending.
					const t = this.takePendingTerminal(record, "cancelled", undefined);
					record.exitCode = t.exitCode;
					await this.finish(record, t.status, signal);
					return { id, status: t.status };
				}
				// The kill ran but the process is still alive, or the executor could not run it. Keep
				// the job running and managed — the sweeper and a repeat `cancel` keep trying — and
				// report the still-running status. Do not clobber an existing timeout intent.
				record.pendingKill ??= "cancelled";
				await this.persist(record).catch(() => undefined);
				this.ensureSweeper();
				return { id, status: record.status };
			});
			results.push(result);
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
		// Freeze the observation set once, up front. `refresh(..., announce=false)` marks a job's
		// completion wake as consumed (the result is being returned inline), so if we re-derived the
		// watch list each iteration a job that finished mid-poll would drop out of "running", never
		// make it into the returned snapshot, and never wake the channel either — the closure lost
		// entirely. With `ids` omitted this is a snapshot of the jobs running *now*; a job started
		// after poll begins is not folded into this call (poll is snapshot semantics — see the tool
		// description).
		const watchedIds =
			ids && ids.length > 0
				? ids.filter((id) => this.jobs.has(id))
				: Array.from(this.jobs.values())
						.filter((job) => job.status === "running")
						.map((job) => job.id);

		while (true) {
			for (const id of watchedIds) {
				const record = this.jobs.get(id);
				if (record) {
					// poll returns the finished job's output to the model inline, so it must not
					// also queue a completion wake for the very same result.
					await this.refresh(record, signal, false);
				}
			}
			const watched = watchedIds
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
				log.logWarn("job.record.unreadable", "Unreadable background job record discarded", {
					fields: { file: filename },
				});
				await unlink(path).catch(() => undefined);
				continue;
			}
			this.jobs.set(record.id, record);
			restored++;
			// One probe decides between "still running", "finished while we were down", and "gone";
			// refresh already encodes all three, including the late completion wake.
			await this.refresh(record, signal).catch((error) => {
				log.logWarn("job.reconcile.failed", "Background job reconcile failed", {
					reason: errorMessage(error),
					fields: { jobId: record?.id },
				});
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

interface JobRuntimeConfig {
	/** Root of the per-desk record directories (`<jobsStateDir>/<desk>/`). */
	jobsStateDir?: string;
	/**
	 * The agent workspace root. A job's full-output spill goes to `<desk>/logs/` so the
	 * "Full output: …" pointer is a file the model can read (fix plan §2.2). The path is stable
	 * across restarts, so a re-adopted job's spill is still found.
	 */
	workspaceDir?: string;
	dispatch?: (event: WakeEvent) => boolean | Promise<boolean>;
	isBoundTo?: JobManagerOptions["isBoundTo"];
	onTaskInput?: JobManagerOptions["onTaskInput"];
	/** Sweep cadence override for the lazily-built desk managers (tests). */
	sweepIntervalMs?: number;
}

/** One application's jobs; the executor and configuration cannot change after construction. */
export function createJobRuntime(executor: Executor, options: JobRuntimeConfig = {}) {
	const config = { ...options };
	const managers = new Map<string, DeskJobManager>();
	let stopped = false;

	function get(desk: string): DeskJobManager {
		let manager = managers.get(desk);
		if (!manager) {
			const deskDir = config.workspaceDir ? getDeskDir(config.workspaceDir, desk) : undefined;
			manager = new DeskJobManager({ desk, deskDir }, executor, {
				...(config.jobsStateDir ? { stateDir: join(config.jobsStateDir, desk) } : {}),
				...(deskDir ? { spillDir: getDeskLogsDir(deskDir) } : {}),
				...(config.dispatch ? { dispatch: config.dispatch } : {}),
				...(config.isBoundTo ? { isBoundTo: config.isBoundTo } : {}),
				...(config.onTaskInput ? { onTaskInput: config.onTaskInput } : {}),
				...(config.sweepIntervalMs ? { sweepIntervalMs: config.sweepIntervalMs } : {}),
			});
			managers.set(desk, manager);
			if (stopped) manager.stop();
		}
		return manager;
	}

	/**
	 * Re-adopt every desk's persisted jobs at startup. Desks are the record directories themselves,
	 * and restore does not depend on bindings (spec 058, D6): a job still running when its desk went
	 * dormant survives the restart too.
	 */
	async function restore(): Promise<number> {
		const jobsStateDir = config.jobsStateDir;
		if (!jobsStateDir) return 0;
		let desks: string[];
		try {
			await mkdir(jobsStateDir, { recursive: true });
			desks = (await readdir(jobsStateDir, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && isDeskName(entry.name))
				.map((entry) => entry.name);
		} catch (error) {
			log.logWarn("job.scan.failed", "Persisted background job scan failed", { reason: errorMessage(error) });
			return 0;
		}

		let restored = 0;
		for (const desk of desks) {
			restored += await get(desk).restore();
		}
		if (restored > 0) {
			log.logInfoEvent("job.restore.done", "Background job records restored", { fields: { count: restored } });
		}
		return restored;
	}

	return {
		get,
		restore,
		stop: () => {
			stopped = true;
			for (const manager of managers.values()) manager.stop();
		},
	};
}

export type JobRuntime = ReturnType<typeof createJobRuntime>;
