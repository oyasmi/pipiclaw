/**
 * Run vocabulary and its pure helpers: the record, registration and settlement shapes, run-id
 * minting and matching, the pending-settlement transform and the record parser. No state and no I/O,
 * so the run manager and the external-run helpers can share it without an import cycle (spec 054 D9/D12).
 */
import { isRecord } from "../shared/type-guards.js";
import type { UsageTotals } from "../usage/totals.js";
import type { WorkspaceBaseline } from "./workspace-summary.js";

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "lost";
export type RunRuntime = "internal" | "external";
export type RunHarness = "claude-code" | "codex-cli" | "exec";
export type RunMutates = "read" | "write";

export type RunResolution =
	| { kind: "found"; record: RunRecord }
	| { kind: "ambiguous"; candidates: RunRecord[] }
	| { kind: "not_found" };

/** The settlement intent persisted before a run's terminal record is published. */
export interface PendingSettlement {
	status: SettleInput["status"];
	failureReason?: string;
	usage: UsageTotals;
	usageKnown: boolean;
	costKnown: boolean;
	turns: number;
	toolCalls: number;
	durationMs: number;
	durationEstimated?: boolean;
	verificationVerdict?: "pass" | "fail";
	workspaceSummary?: string;
	sessionId?: string;
	model?: string;
	finishedAt: number;
	announce: boolean;
}

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
	/** The task's Work Items id this run was dispatched for (spec 052, D4). */
	item?: string;
	workingDirectory: string;
	artifactDir: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
	durationMs?: number;
	failureReason?: string;
	turns?: number;
	toolCalls?: number;
	/** The checker's declared `VERDICT:` for a `purpose=verify` run (spec 052, D6): information for the leader, not a gate. */
	verificationVerdict?: "pass" | "fail";
	/** P2-2: `git status --porcelain` taken right after a `mutates: "write"` run finished, so the
	 *  wake's reader does not have to spend its own first tool call finding out what changed. */
	workspaceSummary?: string;
	/** A write run's dirty-path snapshot at dispatch, so the post-run summary reports only what this
	 *  run changed (see `workspace-summary.ts`). Persisted so restart reconciliation can use it too. */
	workspaceBaseline?: WorkspaceBaseline;
	/** Set once settlement (write output, free resources) has happened; guards against replay. */
	settledAt?: number;
	/**
	 * Durable settlement intent. While this exists the public status remains `running` and the
	 * lease is still held; it lets a restart finish a settlement that crashed after the intent was
	 * recorded but before the terminal record was published.
	 */
	settlementPending?: PendingSettlement;
	/** Set once this run's usage has been written to the ledger; guards against double billing. */
	usageRecorded?: boolean;
	/** Set once this run's cost has been credited to its task. Separate from `usageRecorded` so a
	 *  replayed settlement can never credit it twice. */
	taskAccounted?: boolean;
	/** Set once the completion wake has been hallmarked for delivery; guards against a duplicate wake. */
	wakeEnqueued?: boolean;
	// External-runtime fields; absent on internal runs.
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
	/** Spec 042 D1: the role's wall-time budget, persisted so restart reconciliation can report an
	 *  accurate "budget exceeded (Ns)" reason instead of reverse-engineering it from `deadlineAt`. */
	maxWallTimeSec?: number;
	/** Spec 042 D1: the real process start time (`setLaunched` time), as opposed to `startedAt`
	 *  (registration time) — restart reconciliation's duration estimate is measured from here. */
	processStartedAt?: number;
	/** This run's desk directory, so settlement (including restart reconciliation) can reach the
	 *  owning task's log (spec 052, D4). */
	deskDir?: string;
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
	item?: string;
	workingDirectory: string;
	artifactDir: string;
	/** This run's desk directory — where its owning task lives. Set at registration for every
	 *  runtime, so settlement can credit the task whether the run was internal or external; the
	 *  external launch path re-persists it with the rest of its info. */
	deskDir?: string;
	/** Set only when the caller already holds a workspace write lease for this run (D10.1). */
	leaseKey?: string;
	mutates?: RunMutates;
	workspaceBaseline?: WorkspaceBaseline;
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
	/** P2-2: see `RunRecord.workspaceSummary`. */
	workspaceSummary?: string;
	/** The harness's own session/thread id, captured even on failure so a later resume can still use it. */
	sessionId?: string;
	/** The model that actually produced the result, when it differs from the one registered (an
	 *  internal run that switched to the backup model). Usage is billed against this one. */
	model?: string;
}

/**
 * A best-effort, out-of-band notice about a run — distinct from the completion wake (`dispatch`).
 * The wake is an LLM turn (its delivery latency is whatever the model takes to respond); a notice
 * is plain text rendered straight to the channel, so it reaches the user in roughly the time the
 * run itself takes to settle, not the wake turn's latency on top of that.
 */
export interface RunNotice {
	kind: "settled" | "progress" | "stalled";
	runId: string;
	agent: string;
	/** Only set for `kind: "settled"`. */
	status?: RunStatus;
	durationMs: number;
	/** Only set for `kind: "progress"`: the harness's most recently observed step, already short. */
	step?: string;
	/** Only set for `kind: "stalled"`: how long the run has written no output. */
	silentMs?: number;
}

/** Sends a notice to the run's own channel; `desk` lets the runtime refuse a channel bound elsewhere (D7). */
export type RunNotifier = (desk: string, channelId: string, notice: RunNotice) => void | Promise<void>;

/** D10.2: per-desk cap on concurrently running delegation runs (one run manager per desk, spec 058). */
export const MAX_RUNNING_SUBAGENT_RUNS_PER_DESK = 6;
/** D10.2: host-wide cap across every desk. Bounds unbounded process/worker growth only —
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

export function randomRunIdSuffix(): string {
	let suffix = "";
	for (let i = 0; i < RUN_ID_SUFFIX_LEN; i++) {
		suffix += RUN_ID_ALPHABET[Math.floor(Math.random() * RUN_ID_ALPHABET.length)];
	}
	return suffix;
}

/** Strips a leading `run_` (case-insensitive) so `show a1b2c3` and `show run_a1b2c3` resolve
 *  the same way — nobody should have to remember whether the prefix is required. */
export function normalizeRunIdQuery(query: string): string {
	const lower = query.trim().toLowerCase();
	return lower.startsWith(RUN_ID_PREFIX) ? lower.slice(RUN_ID_PREFIX.length) : lower;
}

/** Settled runs and every runtime-managed artifact are retained together for one week. GC runs
 *  daily, so an item can remain for up to one additional sweep interval after this age. */
export const RUN_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const RUN_ARTIFACT_FILENAMES = [
	"prompt.txt",
	"system-prompt.txt",
	"events.jsonl",
	"stderr.log",
	"output.md",
] as const;

export function isTerminal(status: RunStatus): boolean {
	return status !== "running";
}

export function createPendingSettlement(input: SettleInput, finishedAt: number, announce: boolean): PendingSettlement {
	return {
		status: input.status,
		failureReason: input.failureReason,
		usage: input.usage,
		usageKnown: input.usageKnown,
		costKnown: input.costKnown,
		turns: input.turns,
		toolCalls: input.toolCalls,
		durationMs: input.durationMs,
		durationEstimated: input.durationEstimated,
		verificationVerdict: input.verificationVerdict,
		workspaceSummary: input.workspaceSummary,
		sessionId: input.sessionId,
		model: input.model,
		finishedAt,
		announce,
	};
}

export function applyPendingSettlement(record: RunRecord, pending: PendingSettlement): void {
	record.status = pending.status;
	record.failureReason = pending.failureReason;
	record.usage = pending.usage;
	record.usageKnown = pending.usageKnown;
	record.costKnown = pending.costKnown;
	record.turns = pending.turns;
	record.toolCalls = pending.toolCalls;
	record.durationMs = pending.durationMs;
	record.durationEstimated = pending.durationEstimated;
	record.verificationVerdict = pending.verificationVerdict;
	record.workspaceSummary = pending.workspaceSummary;
	if (pending.sessionId) record.sessionId = pending.sessionId;
	if (pending.model) record.model = pending.model;
	record.finishedAt = pending.finishedAt;
	record.settledAt = pending.finishedAt;
	record.settlementPending = undefined;
}

export function parseRunRecord(raw: string): RunRecord | undefined {
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
