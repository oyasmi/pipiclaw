import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import type { DingTalkEvent } from "../runtime/dingtalk.js";
import type { ChannelStore } from "../runtime/store.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isProcessAlive } from "../shared/host-process.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { UsageTotals } from "../shared/types.js";
import type { UsageLedger } from "../usage/ledger.js";
import { classifyExternalOutcome } from "./external/harness.js";
import { getExternalHarness } from "./external/registry.js";
import { releaseWorkspaceLease } from "./workspace-lease.js";

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

/** D10.2: per-channel cap on concurrently running delegation runs, mirrors job-manager's MAX_RUNNING_JOBS. */
export const MAX_RUNNING_SUBAGENT_RUNS_PER_CHANNEL = 5;
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
	fingerprint?: string;
	argv?: string[];
	sessionId?: string;
	leaseKey?: string;
	mutates?: RunMutates;
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
	dispatch?: (event: DingTalkEvent) => boolean | Promise<boolean>;
	ledger?: UsageLedger;
	store?: ChannelStore;
}

/** Registration is serialized across channel managers so the host-wide count and insertion are
 * one admission transaction. The per-run manager queue alone cannot protect the 19 -> 20 edge
 * when two different channels register concurrently. */
const hostAdmissionQueue = createSerialQueue<"host">();

/** Bytes of the reply text carried inline in the completion wake, matching job-manager's tail budget. */
const WAKE_OUTPUT_TAIL_CHARS = 2_000;

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
		this.runs.delete(record.runId);
		this.cancelHandles.delete(record.runId);
		this.externalLaunches.delete(record.runId);
		const path = this.recordPath(record.runId);
		if (path) await unlink(path).catch(() => undefined);
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
					throw new Error(
						`Too many delegation runs already running on this channel (>= ${MAX_RUNNING_SUBAGENT_RUNS_PER_CHANNEL}). ` +
							"Wait for one to finish, or cancel one with subagent_manage first.",
					);
				}
				if (totalRunningSubAgentRuns() >= MAX_RUNNING_SUBAGENT_RUNS_PER_HOST) {
					throw new Error(
						`Too many delegation runs already running host-wide (>= ${MAX_RUNNING_SUBAGENT_RUNS_PER_HOST}). ` +
							"Wait for one to finish before dispatching another.",
					);
				}
				if (this.runs.has(input.runId)) {
					throw new Error(`Run id "${input.runId}" is already registered on this channel.`);
				}
				const record: RunRecord = {
					...input,
					status: "running",
					startedAt: Date.now(),
					usage: emptyUsage(),
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
		info: { pid: number; fingerprint: string; argv: string[]; sessionId?: string },
	): Promise<void> {
		const record = this.runs.get(runId);
		if (!record) return;
		record.pid = info.pid;
		record.fingerprint = info.fingerprint;
		record.argv = info.argv;
		// claude-code pre-assigns its session id before running (D4); persisting it here, not just
		// at settle(), means a run that crashes before any output is still resumable.
		if (info.sessionId) record.sessionId = info.sessionId;
		await this.persist(record, true);
	}

	/** Reserve a task wake exactly once. A replay of the same durable dispatch may resume an
	 * interrupted activation, while copied text or a different dispatch id can never claim it. */
	async beginWakeConsumption(runId: string, taskId: string, dispatchId: string): Promise<boolean> {
		return this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			const expected = `subagent:${record?.channelId}:${runId}:done`;
			if (
				!record?.settledAt ||
				record.taskId !== taskId ||
				dispatchId !== expected ||
				record.wakeConsumedAt ||
				(record.wakeClaimDispatchId && record.wakeClaimDispatchId !== dispatchId)
			) {
				return false;
			}
			const previousClaim = record.wakeClaimDispatchId;
			record.wakeClaimDispatchId = dispatchId;
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
			if (!record || record.wakeClaimDispatchId !== dispatchId || record.wakeConsumedAt) return;
			record.wakeConsumedAt = Date.now();
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

			record.status = input.status;
			record.failureReason = input.failureReason;
			record.usage = input.usage;
			record.usageKnown = input.usageKnown;
			record.costKnown = input.costKnown;
			record.turns = input.turns;
			record.toolCalls = input.toolCalls;
			record.durationMs = input.durationMs;
			record.verificationVerdict = input.verificationVerdict;
			record.verificationStrength = input.verificationStrength;
			if (input.sessionId) record.sessionId = input.sessionId;
			record.finishedAt = Date.now();
			record.settledAt = record.finishedAt;
			const outputSaved = await this.writeOutputFile(record, input.outputText);
			releaseWorkspaceLease(record.leaseKey);
			await this.persist(record);
			this.cancelHandles.delete(runId);
			this.externalLaunches.delete(runId);

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
				await this.options.store?.logSubAgentRun(record.channelId, {
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
		const event: DingTalkEvent = {
			type: record.channelId.startsWith("group_") ? "group" : "dm",
			channelId: record.channelId,
			user: "SUBAGENT",
			userName: "SUBAGENT",
			text:
				`[SUBAGENT:${record.runId}] Delegation "${record.label}" -> ${record.agent} (${harnessLabel}) finished: ` +
				`${record.status} (${formatDuration(record.durationMs ?? 0)}).${belongsTo}${verdictLine}\n` +
				`Result:\n${tail || "(no output)"}\n` +
				// A run that produced no text has no output.md; pointing at it would send the model
				// after a file that does not exist. The artifact dir still holds the run's evidence
				// (an external run's stderr.log in particular), so that is what it gets instead.
				(outputSaved
					? `Full output: ${join(record.artifactDir, "output.md")}\n`
					: `No text output was produced. Run artifacts: ${record.artifactDir}\n`) +
				"Continue whatever was waiting on this delegation. If it needs no follow-up, respond with exactly [SILENT].",
			ts: String(Date.now()),
			conversationId: "",
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
		return this.queue.run(runId, async () => {
			const record = this.runs.get(runId);
			if (!record) return "not_found";
			if (record.status !== "running") return record.status;
			const cancelHandle = this.cancelHandles.get(runId);
			this.cancelHandles.delete(runId);
			if (cancelHandle) {
				cancelHandle();
			} else if (record.runtime === "external" && this.externalLaunches.has(runId)) {
				// The process has not spawned yet; claimExternalLaunch() will observe this request
				// and refuse to spawn instead of starting an uncancellable child.
				this.externalLaunches.get(runId)!.cancelRequested = true;
			} else {
				// No in-process handle (external runtime, not yet wired, or a run this process did
				// not launch): mark it lost rather than pretend a cancel we could not perform happened.
				record.status = "lost";
				record.finishedAt = Date.now();
				record.settledAt = record.finishedAt;
				record.wakeEnqueued = true;
				releaseWorkspaceLease(record.leaseKey);
				await this.persist(record);
				return record.status;
			}
			return "running"; // The registered cancel handle drives the run to its own settle() call.
		});
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
				await this.reconcileExternalRun(record).catch((error) => {
					log.logWarning(`Failed to reconcile external run ${record?.runId}`, errorMessage(error));
				});
			}
			if (isTerminal(record.status) && record.settledAt) {
				await this.collectGarbageIfExpired(record);
			}
		}
		return restored;
	}

	/**
	 * Restart reconciliation for an external run still marked `running` (D10.3). Unlike internal
	 * runs, a `detached` external process outlives the daemon, so the first move is a liveness
	 * probe, not an automatic `lost`:
	 *
	 * - no `pid` at all: the intent was persisted but spawn was never confirmed — cannot prove it
	 *   ever started, so it is judged `lost` the same as an internal run (D1).
	 * - `pid` alive: genuinely still running. Left alone; it will settle itself when it exits.
	 * - `pid` gone: the process finished or died while the daemon was down. `events.jsonl` is the
	 *   only remaining evidence, so it drives the terminal judgement via the same D4 status table
	 *   the live post-exit path uses.
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
					outputText: "",
				},
				{ announce: true },
			);
			return;
		}
		if (isProcessAlive(record.pid)) {
			return; // Still genuinely running; nothing to reconcile yet.
		}
		const harness = record.harness ? getExternalHarness(record.harness) : undefined;
		const eventsText = await readFile(join(record.artifactDir, "events.jsonl"), "utf-8").catch(() => "");
		const stderrTail = (await readFile(join(record.artifactDir, "stderr.log"), "utf-8").catch(() => "")).slice(
			-2_000,
		);
		const outcome = harness?.parseOutcome({ eventsText, exitCode: undefined, stderrTail }) ?? {
			finalText: "",
			terminalSeen: false,
			protocolStatus: "unparsable" as const,
			usageKnown: false,
			costKnown: false,
			outputTruncated: false,
			stderrTail,
		};
		const classification = harness
			? classifyExternalOutcome(harness.id, outcome)
			: { status: "failed" as const, failureReason: `Unknown harness "${record.harness}"; cannot judge this run.` };
		await this.settle(
			record.runId,
			{
				status: classification.status,
				failureReason: classification.failureReason,
				usage: record.usage,
				usageKnown: outcome.usageKnown,
				costKnown: outcome.costKnown,
				turns: record.turns ?? 0,
				toolCalls: record.toolCalls ?? 0,
				durationMs: Date.now() - record.startedAt,
				outputText: outcome.finalText,
				sessionId: outcome.sessionId,
			},
			{ announce: true },
		);
	}

	/** Drop a settled record once its retention window has passed, mirroring job-manager's GC. */
	private async collectGarbageIfExpired(record: RunRecord, now = Date.now()): Promise<void> {
		const RETENTION_MS = 24 * 60 * 60_000;
		if (record.settledAt && now - record.settledAt >= RETENTION_MS) {
			await this.forget(record);
		}
	}
}

function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
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

/** Give runs their persistence root, wake delivery, ledger, and archive. Called once from bootstrap. */
export function configureSubAgentRuntime(config: RunManagerOptions): void {
	runtimeConfig = config;
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
	if (restored > 0) {
		log.logInfo(`Restored ${restored} sub-agent run record(s)`);
	}
	return restored;
}
