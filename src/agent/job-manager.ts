import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelEvent } from "../channel/channel-event.js";
import type { ExecResult, Executor } from "../executor.js";
import { createFileStore, type FileStore } from "../file-store.js";
import * as log from "../log.js";
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
 * Jobs live on the host, managed through shell commands (`setsid` to launch as its own process
 * group with a startup handshake, a three-state identity probe, a confirmed kill) with no
 * in-process child handles. Records
 * are mirrored to `state/jobs/<channelId>/<id>.json` so they survive a restart: a detached
 * process outlives the daemon, and losing the record while the process kept running meant orphaned
 * work, leaked slots, and unreachable output (spec 031, D6).
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
	/**
	 * A cancel or timeout whose kill could not be *confirmed* yet: the job stays `running` and
	 * manageable, and every sweep re-attempts the kill until the process is proven gone, at which
	 * point this terminal status is applied. Internal only — never surfaced in a `JobSnapshot`.
	 */
	pendingKill?: "cancelled" | "failed";
	wakeClaimDispatchId?: string;
	wakeConsumedAt?: number;
}

/** Every scratch file a single job owns, all derived from its spill path. */
interface JobArtifacts {
	spillFile: string;
	exitFile: string;
	exitTmp: string;
	readyFile: string;
	readyTmp: string;
	metaFile: string;
	metaTmp: string;
}

function jobArtifacts(spillFile: string): JobArtifacts {
	return {
		spillFile,
		exitFile: `${spillFile}.exit`,
		exitTmp: `${spillFile}.exit.tmp`,
		readyFile: `${spillFile}.ready`,
		readyTmp: `${spillFile}.ready.tmp`,
		metaFile: `${spillFile}.meta`,
		metaTmp: `${spillFile}.meta.tmp`,
	};
}

/** ~2s of readiness polling: 40 iterations of a 50ms sleep in the wrapper shell. */
const LAUNCH_HANDSHAKE_MAX_POLLS = 40;

/**
 * Build the wrapper shell that launches a background job with a verifiable startup handshake.
 *
 * The inner shell writes an atomic `ready` marker as its very first action — *before* the user
 * command — so the parent can distinguish "wrapper live, spill writable, command about to run"
 * from "launch silently failed" (a read-only spill dir, a `setsid`/`sh` that could not exec). The
 * parent also writes a metadata file (pid, and under `setsid` the pgid/start-time) *before* it
 * waits on the handshake, so an abort that lands mid-handshake still leaves a recoverable pid.
 *
 * `setsid` (when present) makes the job its own session/process-group leader (pgid == pid), so a
 * later cancel/timeout can terminate the whole group. A host without it falls back to `nohup` —
 * still detached and restart-safe, but single-pid, so pgid/identity are deliberately not claimed.
 *
 * On handshake success the parent prints `MODE`/`PID`(/`PGID`/`LSTART`) and exits 0. On failure it
 * kills whatever it spawned, echoes the inner error, removes the scratch files, and exits 1.
 */
function buildLaunchScript(command: string, art: JobArtifacts): string {
	const spill = shellEscape(art.spillFile);
	const exitFile = shellEscape(art.exitFile);
	const exitTmp = shellEscape(art.exitTmp);
	const ready = shellEscape(art.readyFile);
	const readyTmp = shellEscape(art.readyTmp);
	const meta = shellEscape(art.metaFile);
	const metaTmp = shellEscape(art.metaTmp);

	// Subshell around the user command so its own `exit N` only leaves the subshell and the
	// exit-capture still runs; the exit code is written temp-then-renamed so a probe never reads a
	// half-written `.exit`.
	const inner =
		`printf 'ready\\n' > ${readyTmp} && mv -f ${readyTmp} ${ready} || exit 127; ` +
		`( ${command} )\n__pc_rc=$?; ` +
		`printf '%s\\n' "$__pc_rc" > ${exitTmp} && mv -f ${exitTmp} ${exitFile}`;
	const escInner = shellEscape(inner);

	// `ps` can momentarily miss a just-forked process on a loaded host: one short retry.
	const psField = (field: string) =>
		`"$(ps -o ${field}= -p "$__pc_pid" 2>/dev/null || { sleep 0.1; ps -o ${field}= -p "$__pc_pid" 2>/dev/null; })"`;

	const handshake = (killExpr: string) =>
		`__pc_i=0; while [ ! -s ${ready} ] && [ "$__pc_i" -lt ${LAUNCH_HANDSHAKE_MAX_POLLS} ]; do ` +
		`sleep 0.05; __pc_i=$((__pc_i+1)); done; ` +
		`if [ ! -s ${ready} ]; then ${killExpr}printf 'HANDSHAKE failed\\n'; cat ${spill} 2>/dev/null; ` +
		`rm -f ${ready} ${readyTmp} ${meta} ${metaTmp} ${exitFile} ${exitTmp} ${spill}; exit 1; fi`;

	const setsidKill =
		`kill -TERM "-$__pc_pid" 2>/dev/null; kill -TERM "$__pc_pid" 2>/dev/null; sleep 0.1; ` +
		`kill -KILL "-$__pc_pid" 2>/dev/null; `;
	const nohupKill = `kill -TERM "$__pc_pid" 2>/dev/null; sleep 0.1; kill -KILL "$__pc_pid" 2>/dev/null; `;

	const setsidBranch =
		`setsid sh -c ${escInner} > ${spill} 2>&1 & __pc_pid=$!; ` +
		`__pc_pgid=$(printf '%s' ${psField("pgid")} | tr -d ' '); __pc_lstart=${psField("lstart")}; ` +
		`printf 'MODE setsid\\nPID %s\\nPGID %s\\nLSTART %s\\n' "$__pc_pid" "$__pc_pgid" "$__pc_lstart" ` +
		`> ${metaTmp} && mv -f ${metaTmp} ${meta}; ` +
		`${handshake(setsidKill)}; ` +
		`printf 'MODE setsid\\nPID %s\\nPGID %s\\nLSTART %s\\n' "$__pc_pid" "$__pc_pgid" "$__pc_lstart"`;

	const nohupBranch =
		`nohup sh -c ${escInner} > ${spill} 2>&1 & __pc_pid=$!; ` +
		`printf 'MODE nohup\\nPID %s\\n' "$__pc_pid" > ${metaTmp} && mv -f ${metaTmp} ${meta}; ` +
		`${handshake(nohupKill)}; ` +
		`printf 'MODE nohup\\nPID %s\\n' "$__pc_pid"`;

	// `umask 077`: the spill holds whatever the command printed (routinely credentials) in a
	// world-readable /tmp; set the mask rather than chmod afterwards so there is no readable window.
	return (
		`umask 077; rm -f ${exitFile} ${exitTmp} ${ready} ${readyTmp} ${meta} ${metaTmp}; ` +
		`if command -v setsid >/dev/null 2>&1; then ${setsidBranch}; else ${nohupBranch}; fi`
	);
}

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

/**
 * Read the launch command's stdout: an optional `MODE setsid|nohup` line followed by `PID <n>`
 * and — only in `setsid` mode — `PGID <n>` / `LSTART <...>`. A bare number on its own line is also
 * accepted as the pid so older/simpler executor fakes keep working. `pgid` and `pidStartedAt` are
 * returned only when the job was launched under `setsid` *and* `ps` actually reported them; the
 * `nohup` fallback never yields them, and the caller must then treat identity as unprovable.
 */
function parseLaunchOutput(stdout: string): {
	pid?: number;
	pgid?: number;
	pidStartedAt?: string;
	mode?: "setsid" | "nohup";
	handshakeFailed?: boolean;
} {
	let pid: number | undefined;
	let pgid: number | undefined;
	let pidStartedAt: string | undefined;
	let mode: "setsid" | "nohup" | undefined;
	let handshakeFailed = false;
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (line === "HANDSHAKE failed") {
			handshakeFailed = true;
			continue;
		}
		if (/^\d+$/.test(line)) {
			pid ??= Number.parseInt(line, 10);
			continue;
		}
		const match = line.match(/^(MODE|PID|PGID|LSTART)\s+(.*)$/);
		if (!match) continue;
		const [, key, value] = match;
		if (key === "MODE" && (value === "setsid" || value === "nohup")) mode = value;
		else if (key === "PID" && /^\d+$/.test(value)) pid = Number.parseInt(value, 10);
		else if (key === "PGID" && /^\d+$/.test(value)) pgid = Number.parseInt(value, 10);
		else if (key === "LSTART" && value) pidStartedAt = value;
	}
	// The nohup fallback cannot capture these reliably; drop them even if something printed them.
	if (mode === "nohup") {
		pgid = undefined;
		pidStartedAt = undefined;
	}
	return { pid, pgid, pidStartedAt, mode, handshakeFailed };
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
	 * Launch a command in the background and return its snapshot. The wrapper (`buildLaunchScript`)
	 * runs a readiness handshake before the command executes: only after the inner shell proves it
	 * started — spill writable, `setsid`/`sh` execed — does the parent print `MODE`/`PID` and exit
	 * 0. A failed handshake, a non-zero launch, or an interrupted launch never creates a `running`
	 * record; a persist failure right after a successful launch terminates the process (see below).
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
		const art = jobArtifacts(spillFile);
		const launch = buildLaunchScript(command, art);

		let result: ExecResult;
		try {
			result = await this.executor.exec(launch, { signal: options.signal });
		} catch (error) {
			// The launch was aborted (or the executor could not run it). A detached child may
			// already be running — try to recover its pid and clean it up honestly.
			throw await this.recoverInterruptedLaunch(command, art, error);
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
		this.ensureSweeper();
		return toSnapshot(record);
	}

	/**
	 * Recover from a launch that rejected (an abort landed after the wrapper had already spawned the
	 * detached child, or the executor failed outright). The wrapper writes a metadata file *before*
	 * its readiness handshake, so even an interrupted launch usually leaves a recoverable pid;
	 * clean it up with no caller signal and return an error that is honest about what is known.
	 */
	private async recoverInterruptedLaunch(command: string, art: JobArtifacts, error: unknown): Promise<Error> {
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

		const provisional: JobRecord = {
			id: "(interrupted-launch)",
			label: "(interrupted launch)",
			command,
			status: "running",
			startedAt: Date.now(),
			durationMs: 0,
			pid,
			...(launched.pgid !== undefined ? { pgid: launched.pgid } : {}),
			...(launched.pidStartedAt ? { pidStartedAt: launched.pidStartedAt } : {}),
			spillFile: art.spillFile,
			exitFile: art.exitFile,
			timeoutSeconds: 0,
			contract: { notify: false },
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
		if (this.sweepTimer || this.runningCount() === 0) {
			return;
		}
		this.sweepTimer = setInterval(() => {
			// A timer callback is the last frame that can hold this promise: an unhandled
			// rejection here (a probe that cannot spawn — EAGAIN/EMFILE/ENOMEM) exits the
			// whole daemon, since nothing installs a process-level rejection handler.
			this.sweep().catch((error) => {
				log.logWarning("Background job sweep failed", errorMessage(error));
			});
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
				// The batched probe is a read; the state transition it implies still goes through the
				// per-job slot so it cannot race a concurrent list/poll/cancel.
				await this.reconcileQueue
					.run(record.id, async () => {
						if (record.status !== "running") return;
						await this.applyProbe(record, probes.get(record.id) ?? "");
					})
					.catch((error) => {
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
			// P0-2: a user is waiting on this job's result — render the resulting turn's progress
			// instead of the "none" style autonomous check-ins get.
			presentation: "awaited",
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
	private killCommand(record: JobRecord): string | undefined {
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
	private async runKill(record: JobRecord, signal?: AbortSignal): Promise<KillOutcome> {
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
	/** Sweep cadence override for the lazily-built channel managers (tests). */
	sweepIntervalMs?: number;
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
			...(runtimeConfig.sweepIntervalMs ? { sweepIntervalMs: runtimeConfig.sweepIntervalMs } : {}),
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
