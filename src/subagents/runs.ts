import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import type { ChannelEvent } from "../runtime/channel-event.js";
import type { ChannelStore } from "../runtime/store.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isProcessAlive, killProcessGroup, readProcessStartTime } from "../shared/host-process.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import { createEmptyUsageTotals, type UsageTotals } from "../shared/types.js";
import { beginWakeClaim, finishWakeClaim } from "../shared/wake-claim.js";
import type { UsageLedger } from "../usage/ledger.js";
import { finalizeExternalRun } from "./external/settlement.js";
import { acquireWorkspaceLease, formatWorkspaceLeaseConflict, releaseWorkspaceLease } from "./workspace-lease.js";

/**
 * The run: one abstraction level for delegation, whether it executes as an in-process sub-agent
 * or (from spec 040 phase 2 onward) a short-lived external CLI process. See
 * `docs/specs/040-async-delegation-and-external-agents/design.md`, D1.
 *
 * State machine vocabulary is borrowed from `job-manager.ts`'s `JobStatus` rather than inventing
 * a second one. Only three facts are persisted as idempotent markers (D1/P5) because only three
 * side effects cannot be safely replayed: settling (writes output, frees a lease), recording
 * usage (a ledger write is a real charge), and enqueuing the completion wake (redelivery makes
 * the parent agent re-process the same result). Everything else — duration, tool counts, verdict
 * — is plain data that can be overwritten harmlessly.
 */
export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "lost";
export type RunRuntime = "internal" | "external";
export type RunHarness = "claude-code" | "codex-cli" | "exec";
export type RunMutates = "read" | "write";

/**
 * Longest a dispatching tool call waits for its run to settle before returning a "still running"
 * placeholder instead of the result (D2). A code constant, not a settings key, per CLAUDE.md's
 * rule for numeric thresholds.
 */
export const SYNC_GRACE_MS = 120_000;

/** D10.2: per-channel cap on concurrently running delegation runs. */
export const MAX_RUNNING_SUBAGENT_RUNS_PER_CHANNEL = 6;
/** D10.2: host-wide cap across every channel. Bounds unbounded process/worker growth only —
 *  not the full cross-subsystem (task/job/sidecar) admission scheme the design doc leaves open. */
export const MAX_RUNNING_SUBAGENT_RUNS_PER_HOST = 20;

/**
 * Human-typeable run ids (spec 041). Runs used to be identified by the dispatching tool call's
 * own id, which on some providers is a `call_<24 chars>|fc_<50 chars>` composite — useless in a
 * chat UI where a human has to read it back to cancel or inspect a run. `mintRunId()` on
 * `SubAgentRunManager` produces `run_` + 6 chars instead; the alphabet excludes 0/1/i/l/o/u
 * because those are the characters people misread on a phone screen or misspeak out loud.
 */
export const RUN_ID_PREFIX = "run_";
const RUN_ID_ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";
const RUN_ID_SUFFIX_LEN = 6;

function randomRunIdSuffix(): string {
	let suffix = "";
	for (let i = 0; i < RUN_ID_SUFFIX_LEN; i++) {
		suffix += RUN_ID_ALPHABET[Math.floor(Math.random() * RUN_ID_ALPHABET.length)];
	}
	return suffix;
}

/** Strips a leading `run_` (case-insensitive) so `show a1b2c3` and `show run_a1b2c3` resolve
 *  the same way — nobody should have to remember whether the prefix is required. */
function normalizeRunIdQuery(query: string): string {
	const lower = query.trim().toLowerCase();
	return lower.startsWith(RUN_ID_PREFIX) ? lower.slice(RUN_ID_PREFIX.length) : lower;
}

export type RunResolution =
	| { kind: "found"; record: RunRecord }
	| { kind: "ambiguous"; candidates: RunRecord[] }
	| { kind: "not_found" };

export interface RunUsage {
	usage: UsageTotals;
	/** False only for harnesses that cannot report tokens at all (`exec`). */
	usageKnown: boolean;
	/** False for harnesses that omit a cost field (`codex-cli`, `exec`). */
	costKnown: boolean;
}

export interface RunRecord extends RunUsage {
	runId: string;
	channelId: string;
	runtime: RunRuntime;
	harness?: RunHarness;
	agent: string;
	label: string;
	source: "predefined" | "inline";
	tools: string[];
	model?: string;
	purpose: "work" | "verify";
	taskId?: string;
	workingDirectory: string;
	artifactDir: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	durationMs?: number;
	failureReason?: string;
	turns?: number;
	toolCalls?: number;
	verificationVerdict?: "pass" | "fail";
	/** `enforced` for a built-in verifier (tools structurally removed); `advisory` for external (D9). */
	verificationStrength?: "enforced" | "advisory";
	/** Set once settlement (write output, free resources) has happened; guards against replay. */
	settledAt?: number;
	/** Set once this run's usage has been written to the ledger; guards against double billing. */
	usageRecorded?: boolean;
	/** Set once the completion wake has been hallmarked for delivery; guards against a duplicate wake. */
	wakeEnqueued?: boolean;
	/** Durable one-time relationship between the internally produced wake and task activation (T9). */
	wakeClaimDispatchId?: string;
	wakeConsumedAt?: number;
	// External-runtime fields (spec 040 phase 2+). Present only once the external harness lands;
	// kept optional here so the record shape does not need another migration when it does.
	pid?: number;
	/** `ps`'s `lstart` for `pid` at launch — the OS-verifiable identity check that tells this
	 *  process apart from an unrelated one that later reuses the same pid (D10.3). */
	pidStartedAt?: string;
	/** Wall-clock deadline (`setLaunched` time + `maxWallTimeSec`), so a restart can resume
	 *  enforcing it — an in-process timer dies with the process that set it. */
	deadlineAt?: number;
	/** Set before the kill signal is sent, so whichever code path eventually settles this run (the
	 *  live in-process watcher or the cross-restart deadline check) reports why, instead of guessing from
	 *  protocol output alone (P1-1). */
	terminationReason?: "timeout" | "cancelled";
	argv?: string[];
	sessionId?: string;
	leaseKey?: string;
	mutates?: RunMutates;
	/** Spec 042 D1: persisted at launch so restart reconciliation has the same inputs a live
	 *  watcher would — the workspace subject hash taken just before an external verify run
	 *  started, so a restart can still write its attestation instead of silently skipping it. */
	verifySubjectBefore?: string;
	/** Spec 042 D1: the role's wall-time budget, persisted so restart reconciliation can report an
	 *  accurate "budget exceeded (Ns)" reason instead of reverse-engineering it from `deadlineAt`. */
	maxWallTimeSec?: number;
	/** Spec 042 D1: the real process start time (`setLaunched` time), as opposed to `startedAt`
	 *  (registration time) — restart reconciliation's duration estimate is measured from here. */
	processStartedAt?: number;
	/** Spec 042 D1: needed only to write a verify attestation from restart reconciliation, which
	 *  has no other way to reach the channel directory. */
	channelDir?: string;
	/** True when `durationMs` is a restart-reconciliation estimate rather than a measured process
	 *  lifetime (spec 042 D1) — display surfaces prefix it with "≈". */
	durationEstimated?: boolean;
	/** Spec 042 D10: non-fatal argv-assembly warnings (e.g. a dropped placeholder token) recorded
	 *  at launch, shown by `/subagents show`. */
	invocationWarnings?: string[];
	/** Spec 042 D7: fingerprint of the role's `command`/`externalModelRef`/`shell` at launch time
	 *  (external only) — `follow_up` refuses to resume under a role that has since changed one of
	 *  these instead of silently reinterpreting the old session under a new harness invocation. */
	roleFingerprint?: string;
	/** Spec 042 D12: the harness adapter's own schema version at launch — lets `/subagents show`
	 *  distinguish "the target CLI's own protocol changed under an adapter that hasn't caught up"
	 *  from "the agent itself failed". */
	parserVersion?: number;
	/** Spec 042 D12: best-effort `<executable> --version` output captured at launch (1s timeout,
	 *  `undefined` if the probe failed or timed out) — the other half of the same diagnosis. */
	cliVersion?: string;
}

export interface RegisterRunInput {
	runId: string;
	channelId: string;
	runtime: RunRuntime;
	harness?: RunHarness;
	agent: string;
	label: string;
	source: "predefined" | "inline";
	tools: string[];
	model?: string;
	purpose: "work" | "verify";
	taskId?: string;
	workingDirectory: string;
	artifactDir: string;
	/** Set only when the caller already holds a workspace write lease for this run (D10.1). */
	leaseKey?: string;
}

export interface SettleInput {
	status: "completed" | "failed" | "cancelled" | "lost";
	failureReason?: string;
	usage: UsageTotals;
	usageKnown: boolean;
	costKnown: boolean;
	turns: number;
	toolCalls: number;
	durationMs: number;
	/** True when `durationMs` is a restart-reconciliation estimate rather than a measured process
	 *  lifetime (spec 042 D1) — display surfaces prefix it with "≈". */
	durationEstimated?: boolean;
	/** Full reply text. Settlement saves it to `output.md`; only its tail goes in the wake. */
	outputText: string;
	verificationVerdict?: "pass" | "fail";
	verificationStrength?: "enforced" | "advisory";
	/** The harness's own session/thread id, captured even on failure so a later resume can still use it. */
	sessionId?: string;
}

export interface RunManagerOptions {
	/** Root of the per-channel record directories (`<stateDir>/<channelId>/`). Omit to skip persistence. */
	stateDir?: string;
	dispatch?: (event: ChannelEvent) => boolean | Promise<boolean>;
	ledger?: UsageLedger;
	store?: ChannelStore;
}

/** Registration is serialized across channel managers so the host-wide count and insertion are
 * one admission transaction. The per-run manager queue alone cannot protect the 19 -> 20 edge
 * when two different channels register concurrently. */
const hostAdmissionQueue = createSerialQueue<"host">();

/** Bytes of the reply text carried inline in the completion wake, matching job-manager's tail budget. */
const WAKE_OUTPUT_TAIL_CHARS = 2_000;

/** Settled runs and every runtime-managed artifact are retained together for one week. GC runs
 *  daily, so an item can remain for up to one additional sweep interval after this age. */
const RUN_RETENTION_MS = 7 * 24 * 60 * 60_000;
const RUN_ARTIFACT_FILENAMES = ["prompt.txt", "system-prompt.txt", "events.jsonl", "stderr.log", "output.md"] as const;

async function unlinkIfPresent(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function isTerminal(status: RunStatus): boolean {
	return status !== "running";
}

function parseRunRecord(raw: string): RunRecord | undefined {
	const value: unknown = JSON.parse(raw);
	if (
		!isRecord(value) ||
		typeof value.runId !== "string" ||
		typeof value.channelId !== "string" ||
		(value.runtime !== "internal" && value.runtime !== "external") ||
		typeof value.agent !== "string" ||
		typeof value.workingDirectory !== "string" ||
		typeof value.artifactDir !== "string" ||
		typeof value.status !== "string" ||
		typeof value.startedAt !== "number"
	) {
		return undefined;
	}
	return value as unknown as RunRecord;
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

/**
 * Per-channel manager for delegation runs — the single settlement/usage/wake authority for both
 * internal sub-agents and (once wired) external harnesses (D7). Modeled directly on
 * `ChannelJobManager`; the two are not unified because a run's terminal status depends on a
 * protocol verdict, not just process exit (D4), so the state machines genuinely differ.
 */
export class SubAgentRunManager {
	private readonly runs = new Map<string, RunRecord>();
	/** In-memory cancel handles for runs alive in *this* process (internal runs; external process
	 *  kill goes through pid, not this map, once phase 2/3 lands). Never persisted: a restart loses
	 *  the only thing that could reach an in-process worker anyway (D10.3). */
	private readonly cancelHandles = new Map<string, () => void>();
	/** External launch intents exist before a safe live child handle does. A cancel in that window
	 * is remembered here and consumed before spawn, rather than spawning a process nothing can cancel. */
	private readonly externalLaunches = new Map<string, { cancelRequested: boolean }>();
	/** One-shot deadline checks for external processes adopted during restore. Unlike a child this
	 *  daemon spawned itself, an adopted process cannot emit a `close` event to this process. */
	private readonly externalRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly queue = createSerialQueue<string>();

	constructor(
		private readonly channelId: string,
		private readonly options: RunManagerOptions,
	) {}

	private recordPath(runId: string): string | undefined {
		return this.options.stateDir ? join(this.options.stateDir, this.channelId, `${runId}.json`) : undefined;
	}

	private async persist(record: RunRecord, required = false): Promise<void> {
		const path = this.recordPath(record.runId);
		if (!path) return;
		try {
			await writeFileAtomically(path, `${JSON.stringify(record)}\n`);
		} catch (error) {
			if (required) throw error;
			log.logWarning(`Failed to persist sub-agent run ${record.runId}`, errorMessage(error));
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
			log.logWarning(`Failed to write output.md for sub-agent run ${record.runId}`, errorMessage(error));
			return false;
		}
	}

	private async forget(record: RunRecord): Promise<void> {
		// Delete artifacts before the durable record. If a real filesystem error occurs, retaining
		// the record keeps the run eligible for a later daily retry instead of orphaning its files.
		await Promise.all(RUN_ARTIFACT_FILENAMES.map((name) => unlinkIfPresent(join(record.artifactDir, name))));
		const path = this.recordPath(record.runId);
		if (path) await unlinkIfPresent(path);
		this.runs.delete(record.runId);
		this.cancelHandles.delete(record.runId);
		this.externalLaunches.delete(record.runId);
		this.clearExternalRecoveryTimer(record.runId);
	}

	get(runId: string): RunRecord | undefined {
		return this.runs.get(runId);
	}

	list(): RunRecord[] {
		return Array.from(this.runs.values());
	}

	/** Task ids a still-running delegation on this channel will eventually wake. Feeds `/tasks doctor`. */
	runningTaskIds(): Set<string> {
		const ids = new Set<string>();
		for (const record of this.runs.values()) {
			if (record.status === "running" && record.taskId) {
				ids.add(record.taskId);
			}
		}
		return ids;
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
				// D10.2: a per-channel and a host-wide cap, both code constants (a local response to a
				// runaway model, not a global cross-subsystem admission scheme — see the design doc's
				// non-goals). Checked before anything is persisted, so a rejected run costs nothing.
				if (this.runningCount() >= MAX_RUNNING_SUBAGENT_RUNS_PER_CHANNEL) {
					throw new RecoverableToolError(
						`Too many delegation runs already running on this channel (>= ${MAX_RUNNING_SUBAGENT_RUNS_PER_CHANNEL}). ` +
							"Wait for one to finish, or cancel one with subagent_manage first.",
					);
				}
				if (totalRunningSubAgentRuns() >= MAX_RUNNING_SUBAGENT_RUNS_PER_HOST) {
					throw new RecoverableToolError(
						`Too many delegation runs already running host-wide (>= ${MAX_RUNNING_SUBAGENT_RUNS_PER_HOST}). ` +
							"Wait for one to finish before dispatching another.",
					);
				}
				if (this.runs.has(input.runId)) {
					throw new RecoverableToolError(`Run id "${input.runId}" is already registered on this channel.`);
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
			verifySubjectBefore?: string;
			maxWallTimeSec?: number;
			processStartedAt?: number;
			channelDir?: string;
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
		const record = this.runs.get(runId);
		if (!record) return;
		record.pid = info.pid;
		record.pidStartedAt = info.pidStartedAt;
		record.argv = info.argv;
		record.deadlineAt = info.deadlineAt;
		// claude-code pre-assigns its session id before running (D4); persisting it here, not just
		// at settle(), means a run that crashes before any output is still resumable.
		if (info.sessionId) record.sessionId = info.sessionId;
		record.verifySubjectBefore = info.verifySubjectBefore;
		record.maxWallTimeSec = info.maxWallTimeSec;
		record.processStartedAt = info.processStartedAt;
		record.channelDir = info.channelDir;
		record.invocationWarnings = info.invocationWarnings;
		record.roleFingerprint = info.roleFingerprint;
		record.parserVersion = info.parserVersion;
		record.cliVersion = info.cliVersion;
		await this.persist(record, true);
	}

	/** Reserve a task wake exactly once. A replay of the same durable dispatch may resume an
	 * interrupted activation, while copied text or a different dispatch id can never claim it. */
	async beginWakeConsumption(runId: string, taskId: string, dispatchId: string): Promise<boolean> {
		return this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record) return false;
			const expected = `subagent:${record.channelId}:${runId}:done`;
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
				log.logWarning(`Failed to persist termination reason for run ${runId}`, errorMessage(error));
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

			// The terminal fields are persisted, required, before any side effect runs (P0-2): a
			// failed persist here rolls the record back to `running` so a restart replays settlement
			// from scratch instead of applying side effects the disk never recorded.
			const snapshot = { ...record };
			record.status = input.status;
			record.failureReason = input.failureReason;
			record.usage = input.usage;
			record.usageKnown = input.usageKnown;
			record.costKnown = input.costKnown;
			record.turns = input.turns;
			record.toolCalls = input.toolCalls;
			record.durationMs = input.durationMs;
			record.durationEstimated = input.durationEstimated;
			record.verificationVerdict = input.verificationVerdict;
			record.verificationStrength = input.verificationStrength;
			if (input.sessionId) record.sessionId = input.sessionId;
			record.finishedAt = Date.now();
			record.settledAt = record.finishedAt;
			try {
				await this.persist(record, true);
			} catch (error) {
				Object.assign(record, snapshot);
				throw error;
			}

			const outputSaved = await this.writeOutputFile(record, input.outputText);
			releaseWorkspaceLease(record.leaseKey, record.runId);
			record.leaseKey = undefined; // Terminal records never display as "lease held" (P1-4).
			this.cancelHandles.delete(runId);
			this.externalLaunches.delete(runId);
			this.clearExternalRecoveryTimer(runId);
			await this.persist(record);

			if (!record.usageRecorded) {
				record.usageRecorded = true;
				this.options.ledger?.record({
					channelId: record.channelId,
					kind: "subagent",
					model: record.model ?? "unknown",
					label: record.label,
					runId: record.runId,
					usage: {
						input: input.usage.input,
						output: input.usage.output,
						cacheRead: input.usage.cacheRead,
						cacheWrite: input.usage.cacheWrite,
						total: input.usage.total,
					},
					cost: { ...input.usage.cost },
					usageKnown: input.usageKnown,
					costKnown: input.costKnown,
				});
				// Archive is an observability write, not a settlement fact — a full queue must not
				// swallow the completion wake below (P0-2).
				await this.options.store
					?.logSubAgentRun(record.channelId, {
						date: new Date().toISOString(),
						toolCallId: record.runId,
						label: record.label,
						agent: record.agent,
						source: record.source,
						model: record.model ?? "unknown",
						tools: record.tools,
						turns: input.turns,
						toolCalls: input.toolCalls,
						durationMs: input.durationMs,
						failed: input.status !== "completed",
						failureReason: input.failureReason,
						output: input.outputText.length > 16_000 ? input.outputText.slice(0, 16_000) : input.outputText,
						outputTruncated: input.outputText.length > 16_000,
						usage: { ...input.usage, cost: { ...input.usage.cost } },
						runId: record.runId,
						runtime: record.runtime,
						harness: record.harness,
						status: record.status,
						taskId: record.taskId,
						artifactDir: record.artifactDir,
					})
					.catch((error) => {
						log.logWarning(`Failed to archive sub-agent run ${record.runId}`, errorMessage(error));
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
	 * Dispatch the completion wake. Durable-dispatch persists its own pending record before this
	 * call can be interrupted (`DurableDispatchService.dispatch`), and `dispatch()` is idempotent on
	 * `dispatchId`, so calling it again after a crash between here and marking `wakeEnqueued` is
	 * harmless — this is the same fix as job-manager's `announce()` reordering (D7).
	 */
	private async announce(record: RunRecord, outputText: string, outputSaved: boolean): Promise<void> {
		if (!this.options.dispatch) return;
		const tail = outputText.slice(-WAKE_OUTPUT_TAIL_CHARS).trim();
		const harnessLabel = record.harness ? `${record.runtime}/${record.harness}` : record.runtime;
		const belongsTo = record.taskId ? ` It belongs to task ${record.taskId}.` : "";
		const verdictLine =
			record.verificationVerdict !== undefined
				? `\nVerdict: ${record.verificationVerdict === "pass" ? "PASS" : "FAIL"}${record.verificationStrength === "advisory" ? " (advisory)" : ""}`
				: "";
		const event: ChannelEvent = {
			type: record.channelId.startsWith("group_") ? "group" : "dm",
			channelId: record.channelId,
			user: "SUBAGENT",
			userName: "SUBAGENT",
			text:
				`[SUBAGENT:${record.runId}] Delegation "${record.label}" -> ${record.agent} (${harnessLabel}) finished: ` +
				`${record.status} (${record.durationEstimated ? "≈" : ""}${formatDuration(record.durationMs ?? 0)}).${belongsTo}${verdictLine}\n` +
				`Result:\n${tail || "(no output)"}\n` +
				// A run that produced no text has no output.md; pointing at it would send the model
				// after a file that does not exist. The artifact dir still holds the run's evidence
				// (an external run's stderr.log in particular), so that is what it gets instead.
				(outputSaved
					? `Full output: ${join(record.artifactDir, "output.md")}\n`
					: `No text output was produced. Run artifacts: ${record.artifactDir}\n`) +
				"Continue whatever was waiting on this delegation. If it needs no follow-up, respond with exactly [SILENT].",
			ts: String(Date.now()),
			conversationType: record.channelId.startsWith("group_") ? "2" : "1",
			dispatchId: `subagent:${record.channelId}:${record.runId}:done`,
			...(record.taskId
				? {
						internalWake: {
							kind: "subagent" as const,
							resourceId: record.runId,
							taskId: record.taskId,
							dispatchId: `subagent:${record.channelId}:${record.runId}:done`,
						},
					}
				: {}),
		};
		try {
			await this.options.dispatch(event);
		} catch (error) {
			log.logWarning(`Failed to dispatch completion wake for run ${record.runId}`, errorMessage(error));
			return;
		}
		record.wakeEnqueued = true;
		await this.persist(record);
	}

	/** Explicit cancel (`subagent_manage op=cancel`, spec 040 D6). Does not wake — it is the model's own decision. */
	async cancel(runId: string): Promise<RunStatus | "not_found"> {
		let adoptedRecord: RunRecord | undefined;
		const status = await this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record) return "not_found";
			if (record.status !== "running") return record.status;
			const cancelHandle = this.cancelHandles.get(runId);
			this.cancelHandles.delete(runId);
			if (cancelHandle) {
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
			log.logWarning(`Failed to reconcile cancelled adopted run ${runId}`, errorMessage(error));
		});
		return this.runs.get(runId)?.status ?? status;
	}

	/**
	 * Rebuild in-memory state after a restart. Internal runs cannot survive a restart by
	 * construction (D10.3): the worker lived in the process that just disappeared, so any record
	 * still `running` is settled as `lost` and the channel is woken to say so. External runs are
	 * left alone here — the harness-specific probe (spec 040 phase 2/3) reconciles those.
	 */
	async restore(): Promise<number> {
		const stateDir = this.options.stateDir;
		if (!stateDir) return 0;
		const dir = join(stateDir, this.channelId);
		let filenames: string[];
		try {
			filenames = (await readdir(dir)).filter((name) => name.endsWith(".json"));
		} catch {
			return 0;
		}

		let restored = 0;
		for (const filename of filenames) {
			const path = join(dir, filename);
			let record: RunRecord | undefined;
			try {
				record = parseRunRecord(await readFile(path, "utf-8"));
			} catch {
				record = undefined;
			}
			if (!record) {
				log.logWarning(`Discarding unreadable sub-agent run record: ${filename}`);
				await unlink(path).catch(() => undefined);
				continue;
			}
			this.runs.set(record.runId, record);
			restored++;
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
					log.logWarning(`Failed to reconcile sub-agent run ${record?.runId}`, errorMessage(error));
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
							log.logWarning(`Failed to persist rebuilt lease for run ${record.runId}`, errorMessage(error));
						});
					} else {
						log.logWarning(
							`Could not rebuild workspace lease for adopted run ${record.runId}`,
							formatWorkspaceLeaseConflict(rebuilt.heldBy),
						);
						// This run does not actually hold a lease anymore — record that honestly
						// (spec 042 D5) so a later settle() cannot delete a different holder's lease
						// for the same key, and so displays stop claiming this run still holds it.
						record.leaseKey = undefined;
						await this.persist(record).catch((error) => {
							log.logWarning(`Failed to persist cleared lease for run ${record.runId}`, errorMessage(error));
						});
					}
				}
				await this.reconcileExternalRunAtDeadline(record, Date.now()).catch((error) => {
					log.logWarning(`Failed to reconcile external run ${record?.runId}`, errorMessage(error));
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
						log.logWarning(`Failed to re-announce sub-agent run ${record?.runId}`, errorMessage(error));
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
				runId: record.runId,
				channelId: record.channelId,
				channelDir: record.channelDir,
				harnessId: record.harness,
				purpose: record.purpose,
				taskId: record.taskId,
				workingDirectory: record.workingDirectory,
				artifactDir: record.artifactDir,
				exitCode: undefined,
				durationMs: Math.max(0, durationMs),
				durationEstimated: true,
				terminationReason: record.terminationReason,
				maxWallTimeSec,
				verifySubjectBefore: record.verifySubjectBefore,
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
		if (!record.deadlineAt) return;
		this.clearExternalRecoveryTimer(record.runId);
		const timer = setTimeout(
			() => {
				this.externalRecoveryTimers.delete(record.runId);
				const current = this.runs.get(record.runId);
				if (!current || current.status !== "running") return;
				void this.reconcileExternalRunAtDeadline(current).catch((error) => {
					log.logWarning(`Failed to reconcile adopted external run ${current.runId}`, errorMessage(error));
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
				log.logWarning(`Failed to garbage-collect sub-agent run ${record.runId}`, errorMessage(error));
			});
		}
	}
}

const managers = new Map<string, SubAgentRunManager>();

/** Host-wide running count for the D10.2 admission check, summed across every known channel. */
function totalRunningSubAgentRuns(): number {
	let total = 0;
	for (const manager of managers.values()) {
		total += manager.runningCount();
	}
	return total;
}

let runtimeConfig: RunManagerOptions = {};

const GARBAGE_COLLECTION_INTERVAL_MS = 24 * 60 * 60_000;
let garbageCollectionTimer: ReturnType<typeof setInterval> | undefined;
let collectingGarbage = false;

async function collectGarbageAllChannels(): Promise<void> {
	if (collectingGarbage) return;
	collectingGarbage = true;
	try {
		for (const manager of managers.values()) {
			await manager
				.collectGarbage()
				.catch((error) => log.logWarning("Sub-agent garbage collection failed", errorMessage(error)));
		}
	} finally {
		collectingGarbage = false;
	}
}

function startSubAgentGarbageCollector(): void {
	if (garbageCollectionTimer) clearInterval(garbageCollectionTimer);
	garbageCollectionTimer = setInterval(() => void collectGarbageAllChannels(), GARBAGE_COLLECTION_INTERVAL_MS);
	garbageCollectionTimer.unref?.();
}

/** Stop the host-wide daily garbage collector during shutdown or test teardown. */
export function stopSubAgentGarbageCollector(): void {
	if (garbageCollectionTimer) {
		clearInterval(garbageCollectionTimer);
		garbageCollectionTimer = undefined;
	}
}

/** Give runs their persistence root, wake delivery, ledger, and archive. Called once from bootstrap. */
export function configureSubAgentRuntime(config: RunManagerOptions): void {
	runtimeConfig = config;
	stopSubAgentGarbageCollector();
	startSubAgentGarbageCollector();
}

export function getSubAgentRunManager(channelId: string): SubAgentRunManager {
	let manager = managers.get(channelId);
	if (!manager) {
		manager = new SubAgentRunManager(channelId, runtimeConfig);
		managers.set(channelId, manager);
	}
	return manager;
}

/** Read-only view for `/tasks doctor`, mirroring `channelJobTaskIds`. */
export function channelDelegationTaskIds(channelId: string): Set<string> {
	return managers.get(channelId)?.runningTaskIds() ?? new Set<string>();
}

/**
 * Re-adopt every channel's persisted runs at startup, settling any internal run still marked
 * `running` as `lost` (D10.3). Channels are discovered from the state directory itself, exactly
 * like `restoreChannelJobs`.
 */
export async function restoreAllSubAgentRuns(): Promise<number> {
	const stateDir = runtimeConfig.stateDir;
	if (!stateDir) return 0;
	let channelIds: string[];
	try {
		await mkdir(stateDir, { recursive: true });
		channelIds = (await readdir(stateDir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		log.logWarning("Failed to scan persisted sub-agent runs", errorMessage(error));
		return 0;
	}

	let restored = 0;
	for (const channelId of channelIds) {
		restored += await getSubAgentRunManager(channelId).restore();
	}
	// Reclaim stale runs once as a host-wide startup batch; subsequent batches run daily.
	await collectGarbageAllChannels();
	if (restored > 0) {
		log.logInfo(`Restored ${restored} sub-agent run record(s)`);
	}
	return restored;
}
