import { readdir, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelEvent } from "../channel/channel-event.js";
import type { ChannelStore } from "../channel/store.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isProcessAlive, killProcessGroup, readProcessStartTime } from "../shared/host-process.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { beginWakeClaim, finishWakeClaim } from "../shared/wake-claim.js";
import { logTaskDispatch, logTaskSettlement } from "../tasks/bound-work.js";
import { redeemTicket } from "../tasks/store.js";
import type { UsageLedger } from "../usage/ledger.js";
import { createEmptyUsageTotals } from "../usage/totals.js";
import { buildRunCompletionWake, countWakeSiblings, WAKE_OUTPUT_TAIL_CHARS } from "./completion-wake.js";
import { createProgressPacer, type ProgressPacer, startExternalProgressTail } from "./external/progress-tail.js";
import { finalizeExternalRun } from "./external/settlement.js";
import { runArchiveEntry, runLedgerEntry } from "./run-archive.js";
import {
	applyPendingSettlement,
	createPendingSettlement,
	isTerminal,
	MAX_RUNNING_SUBAGENT_RUNS_PER_DESK,
	MAX_RUNNING_SUBAGENT_RUNS_PER_HOST,
	normalizeRunIdQuery,
	parseRunRecord,
	type RegisterRunInput,
	RUN_ARTIFACT_FILENAMES,
	RUN_ID_PREFIX,
	RUN_RETENTION_MS,
	type RunNotice,
	type RunNotifier,
	type RunRecord,
	type RunResolution,
	type RunStatus,
	randomRunIdSuffix,
	type SettleInput,
} from "./run-record.js";
import { acquireWorkspaceLease, formatWorkspaceLeaseConflict, releaseWorkspaceLease } from "./workspace-lease.js";

/**
 * The run: one abstraction level for delegation, whether it executes as an in-process sub-agent
 * or (from spec 040 phase 2 onward) a short-lived external CLI process. See
 * `docs/archive/specs/040-async-delegation-and-external-agents/design.md`, D1.
 *
 * State machine vocabulary is borrowed from `jobs/manager.ts`'s `JobStatus` rather than inventing
 * a second one. Only three facts are persisted as idempotent markers (D1/P5) because only three
 * side effects cannot be safely replayed: settling (writes output, frees a lease), recording
 * usage (a ledger write is a real charge), and enqueuing the completion wake (redelivery makes
 * the parent agent re-process the same result). Everything else — duration, tool counts, verdict
 * — is plain data that can be overwritten harmlessly.
 */
type ProcessIdentity = "same" | "different" | "unknown";

export interface RunManagerOptions {
	/** Root of the per-desk record directories (`<stateDir>/<desk>/`). Omit to skip persistence. */
	stateDir?: string;
	/** Is a run's channel still bound to this desk (spec 058, D7)? Omitted (TUI, tests): always. */
	isBoundTo?: (channelId: string, desk: string) => boolean;
	dispatch?: (event: ChannelEvent) => boolean | Promise<boolean>;
	/** Best-effort out-of-band notice sink (see `RunNotice`). Never awaited by settlement or the
	 *  progress tail — a slow or failing notifier must not delay either. */
	notify?: RunNotifier;
	ledger?: UsageLedger;
	store?: ChannelStore;
	/** Application-wide admission count, supplied by the owning runtime. */
	runningCount?: () => number;
}

/** Registration is serialized across channel managers so the host-wide count and insertion are
 * one admission transaction. The per-run manager queue alone cannot protect the 19 -> 20 edge
 * when two different channels register concurrently. */
const hostAdmissionQueue = createSerialQueue<"host">();

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

/**
 * Per-desk manager for delegation runs — the single settlement/usage/wake authority for both
 * internal sub-agents and (once wired) external harnesses (D7). Modeled directly on
 * `DeskJobManager`; the two are not unified because a run's terminal status depends on a
 * protocol verdict, not just process exit (D4), so the state machines genuinely differ.
 */
export class SubAgentRunManager {
	private readonly runs = new Map<string, RunRecord>();
	/** In-memory cancel handles for runs alive in *this* process (internal worker abort or live
	 * external process-group kill). Never persisted: a restart cannot reach an in-process worker,
	 * while adopted external runs are cancelled through their persisted pid (D10.3). */
	private readonly cancelHandles = new Map<string, () => void>();
	/** External launch intents exist before a safe live child handle does. A cancel in that window
	 * is remembered here and consumed before spawn, rather than spawning a process nothing can cancel. */
	private readonly externalLaunches = new Map<string, { cancelRequested: boolean }>();
	/** One-shot deadline checks for external processes adopted during restore. Unlike a child this
	 *  daemon spawned itself, an adopted process cannot emit a `close` event to this process. */
	private readonly externalRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Live external runs' tail-the-artifact-file progress pollers (P1a). Never persisted or
	 *  reconstructed on restore — an adopted run has no fresher information to poll for than
	 *  restart reconciliation already reads once from the finished process's own output. */
	private stopped = false;
	private readonly externalProgressTails = new Map<string, { stop(): void }>();
	/** Internal runs that went async report their steps in-process; this paces them exactly like the
	 *  external tail does. Created on first report, dropped at settlement. */
	private readonly internalProgressPacers = new Map<string, ProgressPacer>();
	private readonly queue = createSerialQueue<string>();

	/** `target` owns these runs; each run's own `channelId` is where it reports back. */
	constructor(
		private readonly target: { desk: string; deskDir: string },
		private readonly options: RunManagerOptions,
	) {}

	/** The completion wake's dispatch id — the only id `beginWakeConsumption` accepts for it. */
	private wakeDispatchId(runId: string): string {
		return `subagent:${this.target.desk}:${runId}:done`;
	}

	/** Release observation timers without cancelling dispatched work or its settlement. */
	stop(): void {
		this.stopped = true;
		for (const runId of this.externalRecoveryTimers.keys()) this.clearExternalRecoveryTimer(runId);
		for (const runId of this.externalProgressTails.keys()) this.stopExternalProgressTail(runId);
	}

	private recordDir(): string | undefined {
		// The desk name is a validated path segment; a channel id never is (spec 058, INV-3).
		return this.options.stateDir ? join(this.options.stateDir, this.target.desk) : undefined;
	}

	private recordPath(runId: string): string | undefined {
		const dir = this.recordDir();
		return dir ? join(dir, `${runId}.json`) : undefined;
	}

	private async persist(record: RunRecord, required = false): Promise<void> {
		const path = this.recordPath(record.runId);
		if (!path) return;
		try {
			await writeFileAtomically(path, `${JSON.stringify(record)}\n`);
		} catch (error) {
			if (required) throw error;
			log.logWarn("subagent.persist.failed", "Run persist failed", {
				reason: errorMessage(error),
				fields: { runId: record.runId },
			});
		}
	}

	/**
	 * The full reply text always lands in `<artifactDir>/output.md` (spec 032 D4, carried into 040
	 * D1's settlement step). It is written here, in the one place every runtime settles, rather than
	 * in each caller: the completion wake points at this file, and it is what makes an inline-returned
	 * result self-recoverable after a crash (D2). A failed write must not block settlement — losing
	 * the artifact is bad, leaving the run stuck in `running` is worse.
	 */
	private async writeOutputFile(record: RunRecord, outputText: string): Promise<boolean> {
		if (!outputText.trim()) return false;
		try {
			await writeFileAtomically(join(record.artifactDir, "output.md"), outputText);
			return true;
		} catch (error) {
			log.logWarn("subagent.output.write_failed", "Run output.md write failed", {
				reason: errorMessage(error),
				fields: { runId: record.runId },
			});
			return false;
		}
	}

	/** Fire-and-forget: a notifier failure must never affect settlement or the progress tail. */
	private emitNotice(record: RunRecord, notice: RunNotice): void {
		const notify = this.options.notify;
		if (!notify) return;
		void Promise.resolve()
			.then(() => notify(this.target.desk, record.channelId, notice))
			.catch((error) =>
				log.logWarn("subagent.notice.failed", "Run notice failed", {
					reason: errorMessage(error),
					fields: { runId: notice.runId },
				}),
			);
	}

	/** Start tailing a just-launched external run's artifact file for a human-readable step label
	 *  (P1a). Best-effort only — see `progress-tail.ts` for the polling/pacing contract. */
	private startExternalProgressTail(record: RunRecord): void {
		if (this.stopped) return;
		if (!record.harness) return;
		this.stopExternalProgressTail(record.runId);
		const tail = startExternalProgressTail({
			artifactDir: record.artifactDir,
			harnessId: record.harness,
			startedAt: record.processStartedAt ?? record.startedAt,
			onProgress: (step) => {
				this.emitNotice(record, {
					kind: "progress",
					runId: record.runId,
					agent: record.agent,
					durationMs: Date.now() - (record.processStartedAt ?? record.startedAt),
					step,
				});
			},
			onStall: (silentMs) => {
				this.emitNotice(record, {
					kind: "stalled",
					runId: record.runId,
					agent: record.agent,
					durationMs: Date.now() - (record.processStartedAt ?? record.startedAt),
					silentMs,
				});
			},
		});
		this.externalProgressTails.set(record.runId, tail);
	}

	/**
	 * A step label from an internal run that has outlived its sync grace window: nobody is watching
	 * the tool call any more, so without this the run would be silent until it settles. Paced by the
	 * same rules as an external run's tail; a no-op once the run is no longer running.
	 */
	noteProgress(runId: string, step: string): void {
		if (this.stopped) return;
		const record = this.runs.get(runId);
		if (!record || record.status !== "running" || record.settlementPending) return;
		let pacer = this.internalProgressPacers.get(runId);
		if (!pacer) {
			pacer = createProgressPacer(record.startedAt, (label) =>
				this.emitNotice(record, {
					kind: "progress",
					runId,
					agent: record.agent,
					durationMs: Date.now() - record.startedAt,
					step: label,
				}),
			);
			this.internalProgressPacers.set(runId, pacer);
		}
		pacer.offer(step);
	}

	private stopExternalProgressTail(runId: string): void {
		const tail = this.externalProgressTails.get(runId);
		if (!tail) return;
		tail.stop();
		this.externalProgressTails.delete(runId);
	}

	private async forget(record: RunRecord): Promise<void> {
		// Delete artifacts before the durable record. If a real filesystem error occurs, retaining
		// the record keeps the run eligible for a later daily retry instead of orphaning its files.
		await Promise.all(RUN_ARTIFACT_FILENAMES.map((name) => unlinkIfPresent(join(record.artifactDir, name))));
		// Only removes the directory when it is now actually empty — a run that left extra files
		// behind (e.g. `returns: "artifact"`) keeps its directory, matching the "not recursively
		// removed" contract above; `rmdir` on a non-empty directory just fails and is ignored
		// (review 2026-08-23 §3.6: otherwise every settled run leaves an empty directory forever).
		await rmdir(record.artifactDir).catch(() => {});
		const path = this.recordPath(record.runId);
		if (path) await unlinkIfPresent(path);
		this.runs.delete(record.runId);
		this.cancelHandles.delete(record.runId);
		this.externalLaunches.delete(record.runId);
		this.internalProgressPacers.delete(record.runId);
		this.clearExternalRecoveryTimer(record.runId);
	}

	get(runId: string): RunRecord | undefined {
		return this.runs.get(runId);
	}

	list(): RunRecord[] {
		return Array.from(this.runs.values());
	}

	runningCount(): number {
		return Array.from(this.runs.values()).filter((record) => record.status === "running").length;
	}

	/** Mint a short, human-typeable run id (spec 041). Retried against currently known records;
	 *  the id space (30^6 ≈ 7.3e8) makes a real collision astronomically unlikely, so this is a
	 *  defensive check, not a real bottleneck. */
	mintRunId(): string {
		for (let attempt = 0; attempt < 20; attempt++) {
			const id = `${RUN_ID_PREFIX}${randomRunIdSuffix()}`;
			if (!this.runs.has(id)) return id;
		}
		throw new Error("Could not mint a unique delegation run id.");
	}

	/** Resolve a user- or model-supplied id, exact or by unambiguous prefix (spec 041): `show
	 *  a1b2c3` and `show run_a1b2c3` both work without retyping the full id. */
	resolveRef(query: string): RunResolution {
		const trimmed = query.trim();
		const exact = this.runs.get(trimmed);
		if (exact) return { kind: "found", record: exact };
		const needle = normalizeRunIdQuery(trimmed);
		if (!needle) return { kind: "not_found" };
		const candidates = Array.from(this.runs.values()).filter((record) =>
			normalizeRunIdQuery(record.runId).startsWith(needle),
		);
		if (candidates.length === 1) return { kind: "found", record: candidates[0] };
		if (candidates.length > 1) return { kind: "ambiguous", candidates };
		return { kind: "not_found" };
	}

	/** Register the run's lifecycle before any work starts, and persist it immediately (D1). */
	async register(input: RegisterRunInput): Promise<RunRecord> {
		return hostAdmissionQueue.run("host", () =>
			this.queue.run(input.runId, async () => {
				// D10.2: a per-desk and a host-wide cap, both code constants (a local response to a
				// runaway model, not a global cross-subsystem admission scheme — see the design doc's
				// non-goals). Checked before anything is persisted, so a rejected run costs nothing.
				if (this.runningCount() >= MAX_RUNNING_SUBAGENT_RUNS_PER_DESK) {
					throw new RecoverableToolError(
						`Too many delegation runs already running in this desk (>= ${MAX_RUNNING_SUBAGENT_RUNS_PER_DESK}). ` +
							"Wait for one to finish, or cancel one with subagent_run op=cancel first.",
					);
				}
				if ((this.options.runningCount?.() ?? this.runningCount()) >= MAX_RUNNING_SUBAGENT_RUNS_PER_HOST) {
					throw new RecoverableToolError(
						`Too many delegation runs already running host-wide (>= ${MAX_RUNNING_SUBAGENT_RUNS_PER_HOST}). ` +
							"Wait for one to finish before dispatching another.",
					);
				}
				if (this.runs.has(input.runId)) {
					throw new RecoverableToolError(`Run id "${input.runId}" is already registered in this desk.`);
				}
				const record: RunRecord = {
					...input,
					status: "running",
					startedAt: Date.now(),
					usage: createEmptyUsageTotals(),
					usageKnown: true,
					costKnown: true,
				};
				this.runs.set(record.runId, record);
				if (record.runtime === "external") this.externalLaunches.set(record.runId, { cancelRequested: false });
				try {
					await this.persist(record, true);
				} catch (error) {
					this.runs.delete(record.runId);
					this.externalLaunches.delete(record.runId);
					throw error;
				}
				if (record.taskId) {
					await logTaskDispatch(this.target.deskDir, record.taskId, {
						ref: record.runId,
						item: record.item,
						agent: record.agent,
						purpose: record.purpose,
						label: record.label,
					}).catch((error) => {
						log.logWarn("subagent.task_dispatch.log_failed", "Task dispatch record failed", {
							reason: errorMessage(error),
							fields: { runId: record.runId, taskId: record.taskId },
						});
					});
				}
				return record;
			}),
		);
	}

	/** Atomically crosses the external launch cancel window. The supplied live-handle callback is
	 * installed before this method resolves; a cancel queued during register is observed first and
	 * makes this return false, so the caller must not spawn. */
	async claimExternalLaunch(runId: string, cancel: () => void): Promise<boolean> {
		return this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			const launch = this.externalLaunches.get(runId);
			if (!record || record.status !== "running" || !launch || launch.cancelRequested) {
				this.externalLaunches.delete(runId);
				return false;
			}
			this.cancelHandles.set(runId, cancel);
			this.externalLaunches.delete(runId);
			return true;
		});
	}

	/**
	 * Persist the pid once a spawn actually succeeds — the second half of D1's launch ordering.
	 * `register()` already durably recorded the intent (argv, working directory, artifact dir)
	 * with pid unknown; a crash between that persist and this one leaves an intent-only record
	 * that restore treats as `lost` rather than guessing (D1/D10.3).
	 */
	async setLaunched(
		runId: string,
		info: {
			pid: number;
			pidStartedAt?: string;
			argv: string[];
			deadlineAt: number;
			sessionId?: string;
			/** Spec 042 D1: everything a restart reconciliation might need if this daemon disappears
			 *  before the process exits — restore/deadline recovery must have the same inputs a live watcher
			 *  would, not a thinner subset. */
			maxWallTimeSec?: number;
			processStartedAt?: number;
			deskDir?: string;
			/** Spec 042 D10: non-fatal invocation warnings from argv assembly (e.g. a dropped
			 *  placeholder token), so they survive on the run rather than only ever hitting a log line. */
			invocationWarnings?: string[];
			/** Spec 042 D7: the role's `command`/`externalModelRef`/`shell` fingerprint at launch. */
			roleFingerprint?: string;
			/** Spec 042 D12: the harness adapter's schema version and a best-effort `--version` probe
			 *  of the target CLI, so a later failure can be diagnosed as "adapter is stale" vs. "the
			 *  agent itself failed" instead of looking identical. */
			parserVersion?: number;
			cliVersion?: string;
		},
	): Promise<void> {
		await this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record || record.status !== "running") return;
			record.pid = info.pid;
			record.pidStartedAt = info.pidStartedAt;
			record.argv = info.argv;
			record.deadlineAt = info.deadlineAt;
			// claude-code pre-assigns its session id before running (D4); persisting it here, not just
			// at settle(), means a run that crashes before any output is still resumable.
			if (info.sessionId) record.sessionId = info.sessionId;
			record.maxWallTimeSec = info.maxWallTimeSec;
			record.processStartedAt = info.processStartedAt;
			record.deskDir = info.deskDir;
			record.invocationWarnings = info.invocationWarnings;
			record.roleFingerprint = info.roleFingerprint;
			record.parserVersion = info.parserVersion;
			record.cliVersion = info.cliVersion;
			await this.persist(record, true);
			// P1a: only from here does the process actually exist with a known artifact dir to poll.
			// Never gates the launch itself — a tail failure only means no progress notices, nothing more.
			this.startExternalProgressTail(record);
		});
	}

	/** Persist best-effort probe results after the pid/launch recovery record is already durable.
	 * A slow or unavailable `ps`/`--version` probe must never reopen the post-spawn recovery window. */
	async updateLaunchMetadata(runId: string, info: { pidStartedAt?: string; cliVersion?: string }): Promise<void> {
		await this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record || record.status !== "running" || !record.pid) return;
			if (info.pidStartedAt !== undefined) record.pidStartedAt = info.pidStartedAt;
			if (info.cliVersion !== undefined) record.cliVersion = info.cliVersion;
			await this.persist(record);
		});
	}

	/** Reserve a task wake exactly once. A replay of the same durable dispatch may resume an
	 * interrupted activation, while copied text or a different dispatch id can never claim it. */
	async beginWakeConsumption(runId: string, taskId: string, dispatchId: string): Promise<boolean> {
		return this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record) return false;
			const expected = this.wakeDispatchId(runId);
			const eligible = record.settledAt !== undefined && record.taskId === taskId && dispatchId === expected;
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

	async finishWakeConsumption(runId: string, dispatchId: string): Promise<void> {
		await this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record || !finishWakeClaim(record, dispatchId)) return;
			try {
				await this.persist(record, true);
			} catch (error) {
				record.wakeConsumedAt = undefined;
				throw error;
			}
		});
	}

	/** Let a caller (subagent tool) register a way to abort this run's in-process worker. */
	registerCancelHandle(runId: string, cancel: () => void): void {
		this.cancelHandles.set(runId, cancel);
	}

	/** Record why a still-running external run is about to be killed, before the signal is sent
	 *  (P1-1) — see the `terminationReason` field doc. A no-op once the run is no longer running.
	 *  Called by both the live in-process watcher (`external/run.ts`) and `sweep()` below. */
	async markTerminationReason(runId: string, reason: "timeout" | "cancelled"): Promise<void> {
		await this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record || record.status !== "running") return;
			record.terminationReason = reason;
			await this.persist(record).catch((error) => {
				log.logWarn("subagent.persist.failed", "Termination reason persist failed", {
					reason: errorMessage(error),
					fields: { runId },
				});
			});
		});
	}

	clearCancelHandle(runId: string): void {
		this.cancelHandles.delete(runId);
	}

	/**
	 * Settle a run exactly once (D1/D7 order: settle → record usage/archive → enqueue wake).
	 * `announce: false` is the inline-return path (D2): the model already has the result in this
	 * same tool call, so `wakeEnqueued` is set without ever dispatching — waking the channel for a
	 * result it is already holding would burn a turn to say nothing.
	 */
	async settle(runId: string, input: SettleInput, options: { announce: boolean }): Promise<void> {
		await this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record || record.settledAt) return; // Idempotent: already settled, never replay.

			// Keep the externally visible record `running` while the settlement intent is made durable.
			// This preserves restart recovery without publishing a terminal status before its lease is
			// released: the caller reaches settle() only after its worker/process has finished.
			const snapshot = { ...record };
			const pending = record.settlementPending ?? createPendingSettlement(input, Date.now(), options.announce);
			if (!record.settlementPending) {
				record.settlementPending = pending;
				try {
					await this.persist(record, true);
				} catch (error) {
					Object.assign(record, snapshot);
					throw error;
				}
			}

			const outputSaved = await this.writeOutputFile(record, input.outputText);
			// This is the commit point for the observable state transition. Both operations are
			// synchronous and adjacent: no observer can see a terminal record while this run still
			// owns the lease. The durable intent above covers a crash before this point.
			releaseWorkspaceLease(record.leaseKey, record.runId);
			record.leaseKey = undefined;
			applyPendingSettlement(record, pending);
			// Terminal records never display as "lease held" (P1-4). The terminal write is best-effort:
			// the durable intent above remains available for restart recovery if this publish fails,
			// and the lease must not be reacquired after the process has finished.
			await this.persist(record);
			this.cancelHandles.delete(runId);
			this.externalLaunches.delete(runId);
			this.clearExternalRecoveryTimer(runId);
			this.stopExternalProgressTail(runId);
			this.internalProgressPacers.delete(runId);

			if (!record.usageRecorded) {
				record.usageRecorded = true;
				this.options.ledger?.record(runLedgerEntry(this.target.desk, record, input));
				// Archive is an observability write, not a settlement fact — a full queue must not
				// swallow the completion wake below (P0-2).
				await this.options.store
					?.logSubAgentRun(this.target.deskDir, runArchiveEntry(record, input, pending.status))
					.catch((error) => {
						log.logWarn("subagent.archive.failed", "Run archive failed", {
							reason: errorMessage(error),
							fields: { runId: record.runId },
						});
					});
				await this.persist(record);
			}

			// Spec 052, D4: tell the owning task this work settled — its cost goes onto the task's
			// budget and the outcome onto its log (the board's source), whether or not the run record
			// is still around by the time the leader looks. Guarded by its own idempotency marker
			// inside the same settlement lock, so a replay writes nothing twice.
			if (!record.taskAccounted && record.taskId) {
				record.taskAccounted = true;
				await this.creditOwningTask(record, input, outputSaved).catch((error) => {
					log.logWarn("subagent.task_settle.log_failed", "Task credit for run failed", {
						reason: errorMessage(error),
						fields: { runId: record.runId, taskId: record.taskId },
					});
				});
				await this.persist(record);
			}

			if (record.wakeEnqueued) return;
			if (!options.announce) {
				record.wakeEnqueued = true;
				await this.persist(record);
				return;
			}
			await this.announce(record, input.outputText, outputSaved);
		});
	}

	/**
	 * Credit one settled run to the task that owns it: cost onto its usage, outcome onto its log.
	 * Best-effort by design: a task whose file has since been archived or hand-deleted must not
	 * block the completion wake.
	 */
	private async creditOwningTask(record: RunRecord, input: SettleInput, outputSaved: boolean): Promise<void> {
		const taskId = record.taskId;
		if (!taskId) return;
		await logTaskSettlement(
			this.target.deskDir,
			taskId,
			{
				ref: record.runId,
				item: record.item,
				status: record.status,
				verdict: record.purpose === "verify" ? record.verificationVerdict : undefined,
				output: outputSaved ? join(record.artifactDir, "output.md") : undefined,
				tail: input.outputText.slice(-WAKE_OUTPUT_TAIL_CHARS).trim() || undefined,
				changed: record.workspaceSummary,
				durationMs: input.durationMs,
			},
			{ usd: input.usage.cost.total, estimated: input.costKnown === false },
		);
	}

	/**
	 * Dispatch the completion wake. Durable-dispatch persists its own pending record before this
	 * call can be interrupted (`DurableDispatchService.dispatch`), and `dispatch()` is idempotent on
	 * `dispatchId`, so calling it again after a crash between here and marking `wakeEnqueued` is
	 * harmless — this is the same fix as jobs/manager's `announce()` reordering (D7).
	 */
	private async announce(record: RunRecord, outputText: string, outputSaved: boolean): Promise<void> {
		// P0-1: a settled notice fires whenever this run actually needs a wake — i.e. whenever the
		// caller was not already holding the result in the same tool call (`announce: true`, the same
		// condition that gates the wake below). It reaches the channel in roughly the time the run
		// itself took to settle, independent of the wake turn's own LLM latency on top of that.
		this.emitNotice(record, {
			kind: "settled",
			runId: record.runId,
			agent: record.agent,
			status: record.status,
			durationMs: record.durationMs ?? 0,
		});
		if (!this.options.dispatch) return;
		if (this.options.isBoundTo && !this.options.isBoundTo(record.channelId, this.target.desk)) {
			await this.suppressWake(record);
			return;
		}
		const siblingCount = countWakeSiblings(record, this.runs.values());
		const event = buildRunCompletionWake({
			desk: this.target.desk,
			dispatchId: this.wakeDispatchId(record.runId),
			record,
			outputText,
			outputSaved,
			siblingCount,
		});
		// The `boolean` return value (queue-full/backpressure -> `false`) is deliberately not
		// checked here, unlike the thrown-error case above: `DurableDispatchService.enqueueEvent`
		// puts a rejected record back into `pending` rather than dropping it, and the 30s periodic
		// drain retries it from there -- so marking `wakeEnqueued` on a `false` return is still safe,
		// not a lost wake (fix plan §1.7 / review 2026-08-24 §1.7). Re-verify this against
		// `durable-dispatch.ts` before changing either side.
		try {
			await this.options.dispatch(event);
		} catch (error) {
			log.logWarn("subagent.wake.dispatch_failed", "Completion wake dispatch failed", {
				reason: errorMessage(error),
				fields: { runId: record.runId },
			});
			return;
		}
		record.wakeEnqueued = true;
		await this.persist(record);
	}

	/**
	 * Spec 058, D8: the run's channel left this desk, so the wake has no recipient. Settlement and the
	 * task's settle record already happened; the wake is dropped (marker set, never replayed), and the
	 * `work` ticket it would have redeemed is redeemed here via `redeemTicket`, so the suspended task
	 * resumes as soon as its delivery channel is bound again.
	 */
	private async suppressWake(record: RunRecord): Promise<void> {
		log.logInfoEvent("subagent.wake.suppressed", "Completion wake dropped: channel not bound to the run's desk", {
			channelId: record.channelId,
			fields: { runId: record.runId, desk: this.target.desk, taskId: record.taskId },
		});
		if (record.taskId) {
			await redeemTicket(this.target.deskDir, record.taskId, (ticket) => ticket.kind === "work").catch((error) => {
				log.logWarn("subagent.wake.redeem_failed", "Work ticket redeem for a dropped wake failed", {
					reason: errorMessage(error),
					fields: { runId: record.runId, taskId: record.taskId },
				});
			});
		}
		record.wakeEnqueued = true;
		await this.persist(record);
	}

	/** Explicit cancel (`subagent_run op=cancel`, spec 040 D6). Does not wake — it is the model's own decision. */
	async cancel(runId: string): Promise<RunStatus | "not_found"> {
		let adoptedRecord: RunRecord | undefined;
		const status = await this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record) return "not_found";
			if (record.status !== "running") return record.status;
			const cancelHandle = this.cancelHandles.get(runId);
			if (cancelHandle) {
				// Keep the handle until settle() owns terminal cleanup. A worker may need an async turn to
				// observe abort(); deleting it here would let a second cancel mark an active writer lost,
				// release its lease, and admit another writer while the first worker can still run.
				// External: mark the reason before the handle kills the process, so whichever code
				// path settles this run reports "cancelled" instead of guessing from whatever the
				// process happened to print before it died (P1-1). This also covers
				// the pre-spawn placeholder handle `claimExternalLaunch` installs: a cancel that
				// lands in that narrow window durably marks the intent even though the placeholder
				// itself does nothing else.
				if (record.runtime === "external") {
					record.terminationReason = "cancelled";
					await this.persist(record).catch(() => undefined);
				}
				cancelHandle();
			} else if (record.runtime === "external" && this.externalLaunches.has(runId)) {
				// The process has not spawned yet; claimExternalLaunch() will observe this request
				// and refuse to spawn instead of starting an uncancellable child.
				this.externalLaunches.get(runId)!.cancelRequested = true;
			} else if (record.runtime === "external" && record.pid) {
				// Adopted from a previous daemon (spec 040, D10.3): no live in-process watcher, but
				// the run is genuinely still running. Kill and reconcile it directly rather than
				// waiting for its one-shot deadline check.
				record.terminationReason = "cancelled";
				await this.persist(record).catch(() => undefined);
				await killProcessGroup(record.pid).catch(() => undefined);
				adoptedRecord = record;
			} else {
				// Truly unreachable (e.g. an internal run this process did not launch): mark it lost
				// rather than pretend a cancel we could not perform happened.
				record.status = "lost";
				record.finishedAt = Date.now();
				record.settledAt = record.finishedAt;
				record.wakeEnqueued = true;
				releaseWorkspaceLease(record.leaseKey, record.runId);
				record.leaseKey = undefined;
				await this.persist(record);
				return record.status;
			}
			return "running"; // A live handle or the adopted-run reconciliation below drives settlement.
		});
		if (!adoptedRecord) return status;
		this.clearExternalRecoveryTimer(runId);
		await this.reconcileExternalRun(adoptedRecord).catch((error) => {
			log.logWarn("subagent.reconcile.failed", "Cancelled adopted run reconcile failed", {
				reason: errorMessage(error),
				fields: { runId },
			});
		});
		return this.runs.get(runId)?.status ?? status;
	}

	/**
	 * Rebuild in-memory state after a restart. Internal runs cannot survive a restart by
	 * construction (D10.3): the worker lived in the process that just disappeared, so any record
	 * still `running` is settled as `lost` and the channel is woken to say so. External runs are
	 * left for the harness-specific probe (spec 040 phase 2/3), except an adopted write run whose
	 * lease cannot be rebuilt: it is killed and settled as `lost` rather than allowed to continue
	 * without mutual exclusion.
	 */
	async restore(): Promise<number> {
		const dir = this.recordDir();
		if (!dir) return 0;
		let filenames: string[];
		try {
			filenames = (await readdir(dir)).filter((name) => name.endsWith(".json"));
		} catch {
			return 0;
		}

		let restored = 0;
		for (const filename of filenames) {
			const path = join(dir, filename);
			// A transient I/O error (EACCES, EIO) reading the file is not the same failure as the
			// file actually being corrupt (R7b): the old code unlinked either way, so a run record
			// that only became briefly unreadable (a permissions slip, a filesystem hiccup) was
			// permanently destroyed instead of retried on the next restart. Only a read that
			// actually succeeds gets to judge the content.
			let raw: string;
			try {
				raw = await readFile(path, "utf-8");
			} catch (error) {
				log.logWarn("subagent.record.unreadable", "Unreadable run record skipped (left on disk)", {
					reason: errorMessage(error),
					fields: { file: filename },
				});
				continue;
			}
			let record: RunRecord | undefined;
			try {
				record = parseRunRecord(raw);
			} catch {
				record = undefined;
			}
			if (!record) {
				// Genuinely corrupt content (bad JSON or shape) — quarantine rather than delete, so
				// the evidence survives for a manual look; `.corrupt` files never match the `.json`
				// filter above, so this cannot loop.
				log.logWarn("subagent.record.quarantined", "Corrupt run record quarantined", {
					fields: { file: filename },
				});
				await rename(path, `${path}.corrupt`).catch(() => undefined);
				continue;
			}
			this.runs.set(record.runId, record);
			restored++;
			if (record.settlementPending && !record.settledAt) {
				// A previous process reached the settlement intent after its worker/process had
				// finished, but crashed before publishing the terminal record. The old lease key is
				// process-local and cannot be trusted after restart; clear it before retrying so this
				// recovery cannot release a different run's lease.
				const pending = record.settlementPending;
				record.leaseKey = undefined;
				const outputText = await readFile(join(record.artifactDir, "output.md"), "utf-8").catch(() => "");
				await this.settle(
					record.runId,
					{
						status: pending.status,
						failureReason: pending.failureReason,
						usage: pending.usage,
						usageKnown: pending.usageKnown,
						costKnown: pending.costKnown,
						turns: pending.turns,
						toolCalls: pending.toolCalls,
						durationMs: pending.durationMs,
						durationEstimated: pending.durationEstimated,
						outputText,
						verificationVerdict: pending.verificationVerdict,
						workspaceSummary: pending.workspaceSummary,
						sessionId: pending.sessionId,
					},
					{ announce: pending.announce },
				).catch((error) => {
					log.logWarn("subagent.settle.failed", "Pending settlement could not be finished", {
						reason: errorMessage(error),
						fields: { runId: record?.runId },
					});
				});
				continue;
			}
			if (record.runtime === "internal" && record.status === "running") {
				await this.settle(
					record.runId,
					{
						status: "lost",
						failureReason: "The daemon restarted while this delegation was running; its result is unknown.",
						usage: record.usage,
						usageKnown: record.usageKnown,
						costKnown: record.costKnown,
						turns: record.turns ?? 0,
						toolCalls: record.toolCalls ?? 0,
						durationMs: Date.now() - record.startedAt,
						outputText: "",
					},
					{ announce: true },
				).catch((error) => {
					log.logWarn("subagent.reconcile.failed", "Run reconcile failed", {
						reason: errorMessage(error),
						fields: { runId: record?.runId },
					});
				});
			}
			if (record.runtime === "external" && record.status === "running") {
				// A write run adopted mid-flight must keep excluding other writers the same way it
				// did before the restart (D10.1); the lease itself is a process-local Map, so a
				// fresh process starts with none held until this rebuilds it (P0-1).
				if (record.leaseKey) {
					const rebuilt = acquireWorkspaceLease({
						runId: record.runId,
						channelId: record.channelId,
						workingDirectory: record.workingDirectory,
					});
					if (rebuilt.ok) {
						// Spec 042 D5: persist what was *actually* acquired, not just trust the old
						// value — a symlink swap or a checkout replaced at the same path can make the
						// realpath drift between restarts.
						record.leaseKey = rebuilt.leaseKey;
						await this.persist(record).catch((error) => {
							log.logWarn("subagent.lease.persist_failed", "Rebuilt lease persist failed", {
								reason: errorMessage(error),
								fields: { runId: record.runId },
							});
						});
					} else {
						log.logWarn("subagent.lease.rebuild_failed", "Workspace lease for adopted run could not be rebuilt", {
							reason: formatWorkspaceLeaseConflict(rebuilt.heldBy),
							fields: { runId: record.runId },
						});
						// This run cannot safely continue without its lease: it could write concurrently
						// with the holder that won the restart race. Kill the adopted process only after
						// confirming its persisted pid identity; a reused pid must never receive a signal.
						// Either an identity mismatch or an unavailable probe is settled as lost with the
						// uncertainty recorded, instead of silently degrading to an unprotected writer
						// (D10.1/D10.3).
						const processIdentity = record.pid ? await this.processIdentity(record) : "unknown";
						let processSafetyNote: string;
						if (processIdentity === "same") {
							await killProcessGroup(record.pid!).catch(() => undefined);
							processSafetyNote = " The adopted process identity matched and its process group was signalled.";
						} else if (processIdentity === "different") {
							processSafetyNote =
								" The persisted pid identity did not match the current process; no signal was sent.";
						} else {
							processSafetyNote =
								" The adopted process identity could not be confirmed; no signal was sent, so its result remains unknown.";
						}
						// Clear the stale key first so settlement cannot delete the other run's lease.
						record.leaseKey = undefined;
						await this.persist(record).catch((error) => {
							log.logWarn("subagent.lease.persist_failed", "Cleared lease persist failed", {
								reason: errorMessage(error),
								fields: { runId: record.runId },
							});
						});
						await this.settle(
							record.runId,
							{
								status: "lost",
								failureReason:
									"The daemon restarted while this write delegation's workspace lease was held by another run; its result is unknown." +
									processSafetyNote,
								usage: record.usage,
								usageKnown: record.usageKnown,
								costKnown: record.costKnown,
								turns: record.turns ?? 0,
								toolCalls: record.toolCalls ?? 0,
								durationMs: Date.now() - (record.processStartedAt ?? record.startedAt),
								durationEstimated: true,
								outputText: "",
							},
							{ announce: true },
						).catch((error) => {
							log.logWarn("subagent.settle.failed", "Lease-conflicted run settlement failed", {
								reason: errorMessage(error),
								fields: { runId: record?.runId },
							});
						});
						continue;
					}
				}
				await this.reconcileExternalRunAtDeadline(record, Date.now()).catch((error) => {
					log.logWarn("subagent.reconcile.failed", "External run reconcile failed", {
						reason: errorMessage(error),
						fields: { runId: record?.runId },
					});
				});
				if (record.status === "running") this.scheduleExternalRecovery(record);
			}
			if (isTerminal(record.status) && record.settledAt) {
				// A settled-but-unwoken record means the wake was lost between settlement and
				// dispatch (e.g. the archive-queue failure this restart may itself be recovering
				// from, P0-2) — durable dispatch is idempotent on dispatchId, so re-announcing is
				// harmless even if the original wake actually made it out.
				if (!record.wakeEnqueued) {
					const outputText = await readFile(join(record.artifactDir, "output.md"), "utf-8").catch(() => "");
					await this.announce(record, outputText, Boolean(outputText.trim())).catch((error) => {
						log.logWarn("subagent.wake.reannounce_failed", "Run re-announce failed", {
							reason: errorMessage(error),
							fields: { runId: record?.runId },
						});
					});
				}
			}
		}
		return restored;
	}

	/** Whether `record.pid` is still the same process that was launched, when that can be checked
	 *  at all (D10.3). A missing `pidStartedAt` (an older record, or a `ps` that failed once at
	 *  launch) means there is nothing to compare against — trust `isProcessAlive` alone rather
	 *  than manufacture a false negative. */
	private async isSameProcess(record: RunRecord): Promise<boolean> {
		if (!record.pid) return false;
		if (!record.pidStartedAt) return true;
		const current = await readProcessStartTime(record.pid);
		return current === record.pidStartedAt;
	}

	private async processIdentity(record: RunRecord): Promise<ProcessIdentity> {
		if (!record.pid || !record.pidStartedAt) return "unknown";
		const current = await readProcessStartTime(record.pid);
		if (!current) return "unknown";
		return current === record.pidStartedAt ? "same" : "different";
	}

	/**
	 * Restart reconciliation for an external run still marked `running` (D10.3), and the terminal
	 * judgement `sweep()` uses once an adopted run's process is confirmed gone. Unlike internal
	 * runs, a `detached` external process outlives the daemon, so the first move is a liveness
	 * probe, not an automatic `lost`:
	 *
	 * - no `pid` at all: the intent was persisted but spawn was never confirmed — cannot prove it
	 *   ever started, so it is judged `lost` the same as an internal run (D1).
	 * - `pid` alive under the same identity: genuinely still running. Left alone.
	 * - `pid` gone (or reused by an unrelated process): the process finished, died, or was killed
	 *   while the daemon was down. `finalizeExternalRun` (spec 042 D1) parses whatever the process
	 *   actually wrote before applying `terminationReason` — the same sequence the live post-exit
	 *   path uses, so a reconciled run never loses usage, output, session id, or its verify verdict
	 *   just because the daemon happened to be down when the run finished.
	 */
	private async reconcileExternalRun(record: RunRecord): Promise<void> {
		if (!record.pid) {
			await this.settle(
				record.runId,
				{
					status: "lost",
					failureReason: "No pid was ever recorded for this run; it cannot be proven to have started.",
					usage: record.usage,
					usageKnown: record.usageKnown,
					costKnown: record.costKnown,
					turns: record.turns ?? 0,
					toolCalls: record.toolCalls ?? 0,
					durationMs: Date.now() - record.startedAt,
					durationEstimated: true,
					outputText: "",
				},
				{ announce: true },
			);
			return;
		}
		if (isProcessAlive(record.pid) && (await this.isSameProcess(record))) {
			return; // Still genuinely running; nothing to reconcile yet.
		}
		if (!record.harness) {
			// Defensive only: external runs always get a harness at register() time (spec 040 D1).
			await this.settle(
				record.runId,
				{
					status: "failed",
					failureReason: "Run has no recorded harness; cannot judge it.",
					usage: record.usage,
					usageKnown: record.usageKnown,
					costKnown: record.costKnown,
					turns: record.turns ?? 0,
					toolCalls: record.toolCalls ?? 0,
					durationMs: Date.now() - record.startedAt,
					durationEstimated: true,
					outputText: "",
				},
				{ announce: true },
			);
			return;
		}

		// Duration can only be estimated post-restart: the artifact file's own mtime is the closest
		// proxy for "when the process last wrote something" (D1); wall clock from the last known
		// process start is the fallback when the file is missing (e.g. already GC'd).
		const processStartedAt = record.processStartedAt ?? record.startedAt;
		let durationMs = Date.now() - processStartedAt;
		try {
			const eventsStat = await stat(join(record.artifactDir, "events.jsonl"));
			durationMs = eventsStat.mtimeMs - processStartedAt;
		} catch {
			// No events file (or already GC'd) — fall back to the wall-clock estimate above.
		}

		const maxWallTimeSec =
			record.maxWallTimeSec ??
			(record.deadlineAt ? Math.round((record.deadlineAt - record.startedAt) / 1000) : undefined);

		await finalizeExternalRun(
			{
				harnessId: record.harness,
				purpose: record.purpose,
				workingDirectory: record.workingDirectory,
				artifactDir: record.artifactDir,
				exitCode: undefined,
				durationMs: Math.max(0, durationMs),
				durationEstimated: true,
				terminationReason: record.terminationReason,
				maxWallTimeSec,
				mutates: record.mutates,
				workspaceBaseline: record.workspaceBaseline,
			},
			(settleInput, options) => this.settle(record.runId, settleInput, options),
			{ announce: record.terminationReason !== "cancelled" },
		);
	}

	/** Reconcile an adopted process once at restore and once at its persisted deadline. Probing
	 *  liveness before assigning a timeout lets a process that finished just before the deadline be
	 *  settled from its artifacts as a normal completion. */
	private async reconcileExternalRunAtDeadline(record: RunRecord, now = Date.now()): Promise<void> {
		if (
			record.pid &&
			record.deadlineAt &&
			now >= record.deadlineAt &&
			record.terminationReason !== "timeout" &&
			isProcessAlive(record.pid) &&
			(await this.isSameProcess(record))
		) {
			await this.markTerminationReason(record.runId, "timeout");
			await killProcessGroup(record.pid).catch(() => undefined);
		}
		await this.reconcileExternalRun(record);
	}

	private clearExternalRecoveryTimer(runId: string): void {
		const timer = this.externalRecoveryTimers.get(runId);
		if (!timer) return;
		clearTimeout(timer);
		this.externalRecoveryTimers.delete(runId);
	}

	private scheduleExternalRecovery(record: RunRecord): void {
		if (this.stopped) return;
		if (!record.deadlineAt) return;
		this.clearExternalRecoveryTimer(record.runId);
		const timer = setTimeout(
			() => {
				this.externalRecoveryTimers.delete(record.runId);
				const current = this.runs.get(record.runId);
				if (!current || current.status !== "running") return;
				// Timers can fire just before their wall-clock deadline. Re-arm rather than losing
				// the only recovery check and leaving an adopted process running indefinitely.
				if (current.deadlineAt && Date.now() < current.deadlineAt) {
					this.scheduleExternalRecovery(current);
					return;
				}
				void this.reconcileExternalRunAtDeadline(current).catch((error) => {
					log.logWarn("subagent.reconcile.failed", "Adopted external run reconcile failed", {
						reason: errorMessage(error),
						fields: { runId: current.runId },
					});
				});
			},
			Math.max(0, record.deadlineAt - Date.now()),
		);
		timer.unref?.();
		this.externalRecoveryTimers.set(record.runId, timer);
	}

	/**
	 * Daily retention GC. A settled run and all runtime-managed artifacts are deleted together once
	 * they are at least seven days old. Other files deliberately created by the delegated task are
	 * not recursively removed from the artifact directory.
	 */
	private async collectGarbageIfExpired(record: RunRecord, now = Date.now()): Promise<void> {
		if (!record.settledAt) return;
		if (now - record.settledAt >= RUN_RETENTION_MS) {
			await this.forget(record);
		}
	}

	async collectGarbage(now = Date.now()): Promise<void> {
		for (const record of Array.from(this.runs.values())) {
			if (!isTerminal(record.status)) continue;
			await this.collectGarbageIfExpired(record, now).catch((error) => {
				log.logWarn("subagent.gc.failed", "Run garbage collection failed", {
					reason: errorMessage(error),
					fields: { runId: record.runId },
				});
			});
		}
	}
}

/**
 * The channel each record directory belongs to. The id is read out of a record itself — the one
 * lossless source, since a directory name is the *escaped* id and `__` cannot be turned back
 * into `/` — with the directory name as the fallback for a directory without a readable record.
 */
