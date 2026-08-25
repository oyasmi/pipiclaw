import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { parseLocalTime } from "../shared/local-time.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";

export interface MemoryMaintenanceState {
	channelId: string;
	dirty: boolean;
	lastActivityAt?: string;
	eligibleAfter?: string;
	lastSessionRefreshAt?: string;
	lastCheckpointAt?: string;
	lastStructuralMaintenanceAt?: string;
	turnsSinceSessionRefresh: number;
	toolCallsSinceSessionRefresh: number;
	lastSessionEntryId?: string;
	lastSessionRefreshedEntryId?: string;
	lastCheckpointEntryId?: string;
	failureBackoffUntil?: string | null;
}

export type MemoryActivityKind = "user-turn-started" | "tool-call" | "assistant-turn-completed" | "boundary";

export interface MemoryActivityEvent {
	kind: MemoryActivityKind;
	channelId: string;
	timestamp: string;
	eligibleAfter?: string;
	latestSessionEntryId?: string;
}

/**
 * A run of activity events collapsed into the delta they would have produced.
 *
 * Every field mirrors exactly what {@link applyMemoryActivityToState} does for a single event:
 * last-write-wins for the timestamps and the entry cursor, `+= 1` for the two counters, and a
 * sticky `dirty`. Because each of those is associative, an arbitrarily long burst folds into a
 * fixed-size delta — which is what lets the recorder below buffer a whole tool-heavy turn without
 * growing, and what makes the buffered result provably identical to writing each event in turn.
 */
interface PendingMemoryActivity {
	lastActivityAt: string;
	eligibleAfter?: string;
	latestSessionEntryId?: string;
	toolCalls: number;
	turns: number;
	dirty: boolean;
}

const stateUpdateQueue = createSerialQueue<string>();

export function getMemoryMaintenanceStateDir(appHomeDir: string): string {
	return join(appHomeDir, "state", "memory");
}

export function getMemoryMaintenanceStatePath(appHomeDir: string, channelId: string): string {
	return join(getMemoryMaintenanceStateDir(appHomeDir), `${channelId}.json`);
}

function createDefaultState(channelId: string): MemoryMaintenanceState {
	return {
		channelId,
		dirty: false,
		turnsSinceSessionRefresh: 0,
		toolCallsSinceSessionRefresh: 0,
		failureBackoffUntil: null,
	};
}

function normalizeOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeOptionalNullableString(value: unknown): string | null | undefined {
	if (value === null) {
		return null;
	}
	return normalizeOptionalString(value);
}

function normalizeCounter(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function laterTimestamp(a: string | undefined, b: string | undefined): string | undefined {
	if (!a) return b;
	if (!b) return a;
	return (parseLocalTime(a) ?? -Infinity) >= (parseLocalTime(b) ?? -Infinity) ? a : b;
}

function normalizeState(channelId: string, value: unknown): MemoryMaintenanceState {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return createDefaultState(channelId);
	}
	const record = value as Record<string, unknown>;
	return {
		channelId,
		dirty: typeof record.dirty === "boolean" ? record.dirty : false,
		lastActivityAt: normalizeOptionalString(record.lastActivityAt),
		eligibleAfter: normalizeOptionalString(record.eligibleAfter),
		lastSessionRefreshAt: normalizeOptionalString(record.lastSessionRefreshAt),
		// Legacy states carried separate consolidation/growth-review fields; fold them
		// into the merged checkpoint so cadence and cursor survive the migration.
		lastCheckpointAt:
			normalizeOptionalString(record.lastCheckpointAt) ??
			laterTimestamp(
				normalizeOptionalString(record.lastDurableConsolidationAt),
				normalizeOptionalString(record.lastGrowthReviewAt),
			),
		lastStructuralMaintenanceAt: normalizeOptionalString(record.lastStructuralMaintenanceAt),
		turnsSinceSessionRefresh: normalizeCounter(record.turnsSinceSessionRefresh),
		toolCallsSinceSessionRefresh: normalizeCounter(record.toolCallsSinceSessionRefresh),
		lastSessionEntryId: normalizeOptionalString(record.lastSessionEntryId),
		lastSessionRefreshedEntryId: normalizeOptionalString(record.lastSessionRefreshedEntryId),
		lastCheckpointEntryId:
			normalizeOptionalString(record.lastCheckpointEntryId) ??
			normalizeOptionalString(record.lastConsolidatedEntryId) ??
			normalizeOptionalString(record.lastReviewedEntryId),
		failureBackoffUntil: normalizeOptionalNullableString(record.failureBackoffUntil) ?? null,
	};
}

export async function readMemoryMaintenanceState(
	appHomeDir: string,
	channelId: string,
): Promise<MemoryMaintenanceState> {
	const path = getMemoryMaintenanceStatePath(appHomeDir, channelId);
	try {
		const raw = await readFile(path, "utf-8");
		return normalizeState(channelId, JSON.parse(raw) as unknown);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return createDefaultState(channelId);
		}
		const message = errorMessage(error);
		log.logWarning(`[${channelId}] Failed to read memory maintenance state; rebuilding defaults`, message);
		return createDefaultState(channelId);
	}
}

export async function updateMemoryMaintenanceState(
	appHomeDir: string,
	channelId: string,
	update: (state: MemoryMaintenanceState) => MemoryMaintenanceState,
): Promise<MemoryMaintenanceState> {
	const path = getMemoryMaintenanceStatePath(appHomeDir, channelId);
	return stateUpdateQueue.run(path, async () => {
		const current = await readMemoryMaintenanceState(appHomeDir, channelId);
		const next = normalizeState(channelId, update(current));
		await writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
		return next;
	});
}

function mergeMemoryActivity(
	pending: PendingMemoryActivity | undefined,
	event: MemoryActivityEvent,
): PendingMemoryActivity {
	const next: PendingMemoryActivity = pending ?? {
		lastActivityAt: event.timestamp,
		toolCalls: 0,
		turns: 0,
		dirty: false,
	};
	next.lastActivityAt = event.timestamp;
	next.eligibleAfter = event.eligibleAfter ?? next.eligibleAfter;
	next.latestSessionEntryId = event.latestSessionEntryId ?? next.latestSessionEntryId;
	if (event.kind === "tool-call") {
		next.dirty = true;
		next.toolCalls += 1;
	}
	if (event.kind === "assistant-turn-completed") {
		next.dirty = true;
		next.turns += 1;
	}
	if (event.kind === "boundary") {
		next.dirty = true;
	}
	return next;
}

function applyPendingActivityToState(
	state: MemoryMaintenanceState,
	channelId: string,
	pending: PendingMemoryActivity,
): MemoryMaintenanceState {
	return {
		...state,
		channelId,
		lastActivityAt: pending.lastActivityAt,
		eligibleAfter: pending.eligibleAfter ?? state.eligibleAfter,
		lastSessionEntryId: pending.latestSessionEntryId ?? state.lastSessionEntryId,
		dirty: state.dirty || pending.dirty,
		toolCallsSinceSessionRefresh: state.toolCallsSinceSessionRefresh + pending.toolCalls,
		turnsSinceSessionRefresh: state.turnsSinceSessionRefresh + pending.turns,
	};
}

/** Apply a single activity event. The buffered path folds a whole burst through the same core. */
export function applyMemoryActivityToState(
	state: MemoryMaintenanceState,
	event: MemoryActivityEvent,
): MemoryMaintenanceState {
	return applyPendingActivityToState(state, event.channelId, mergeMemoryActivity(undefined, event));
}

/**
 * Buffers activity events and writes them out in batches.
 *
 * Activity is recorded on *every* tool call, and each write used to be a read-modify-write of a
 * JSON file through `writeFileAtomically` — two fsyncs apiece. A thirty-step turn paid that thirty
 * times, on storage whose fsync latency the runtime does not control.
 *
 * Batching is safe because nothing consumes this state promptly: every gate in
 * `maintenance-gates.ts` denies outright while the channel is active, and `eligibleAfter` holds
 * maintenance off for `minIdleMinutesBeforeLlmWork` after that. The scheduler then polls once a
 * minute. So the state only has to be accurate by the time a channel goes *idle* — which is why
 * the runner also flushes explicitly at the end of every turn, on top of the debounce here. The
 * debounce bounds what a crash can lose to a few seconds of counters, never a checkpoint: those
 * are written directly, and the serial queue keeps a flush from reordering against them.
 */
export interface MemoryActivityRecorder {
	record(event: MemoryActivityEvent): void;
	/** Write out buffered activity for one channel, or for all of them when `channelId` is omitted. */
	flush(channelId?: string): Promise<void>;
}

export const DEFAULT_ACTIVITY_FLUSH_DEBOUNCE_MS = 5_000;

export interface CreateMemoryActivityRecorderOptions {
	appHomeDir: string;
	/** Override the flush debounce; tests use a short one. */
	debounceMs?: number;
	onError?: (channelId: string, error: unknown) => void;
}

export function createMemoryActivityRecorder(options: CreateMemoryActivityRecorderOptions): MemoryActivityRecorder {
	const debounceMs = options.debounceMs ?? DEFAULT_ACTIVITY_FLUSH_DEBOUNCE_MS;
	const pending = new Map<string, PendingMemoryActivity>();
	const timers = new Map<string, NodeJS.Timeout>();
	/** The most recent write per channel, so `flush` can await work another caller started. */
	const inFlight = new Map<string, Promise<void>>();

	const cancelTimer = (channelId: string): void => {
		const timer = timers.get(channelId);
		if (timer) {
			clearTimeout(timer);
			timers.delete(channelId);
		}
	};

	const flushChannel = (channelId: string): Promise<void> => {
		cancelTimer(channelId);
		const delta = pending.get(channelId);
		if (!delta) {
			return inFlight.get(channelId) ?? Promise.resolve();
		}
		// Cleared before the await so events arriving during the write start a fresh batch
		// instead of being swallowed by this one.
		pending.delete(channelId);
		const write = updateMemoryMaintenanceState(options.appHomeDir, channelId, (state) =>
			applyPendingActivityToState(state, channelId, delta),
		)
			.then(() => undefined)
			.catch((error: unknown) => {
				// Put the delta back so the counters are not silently lost; the next event (or
				// flush) retries it, folded in front of anything buffered while this write ran.
				pending.set(channelId, mergeBack(delta, pending.get(channelId)));
				options.onError?.(channelId, error);
			})
			.finally(() => {
				if (inFlight.get(channelId) === write) {
					inFlight.delete(channelId);
				}
			});
		inFlight.set(channelId, write);
		return write;
	};

	return {
		record(event: MemoryActivityEvent): void {
			pending.set(event.channelId, mergeMemoryActivity(pending.get(event.channelId), event));
			if (timers.has(event.channelId)) {
				return;
			}
			const timer = setTimeout(() => {
				timers.delete(event.channelId);
				void flushChannel(event.channelId);
			}, debounceMs);
			// Buffered counters are never a reason to keep the process alive.
			timer.unref?.();
			timers.set(event.channelId, timer);
		},

		async flush(channelId?: string): Promise<void> {
			const channelIds = channelId ? [channelId] : new Set([...pending.keys(), ...inFlight.keys()]);
			await Promise.all([...channelIds].map((id) => flushChannel(id)));
		},
	};
}

/** Fold a failed batch back in front of whatever accumulated while it was in flight. */
function mergeBack(failed: PendingMemoryActivity, current: PendingMemoryActivity | undefined): PendingMemoryActivity {
	if (!current) {
		return failed;
	}
	return {
		// `current` is the newer batch, so it wins on every last-write-wins field.
		lastActivityAt: current.lastActivityAt,
		eligibleAfter: current.eligibleAfter ?? failed.eligibleAfter,
		latestSessionEntryId: current.latestSessionEntryId ?? failed.latestSessionEntryId,
		toolCalls: failed.toolCalls + current.toolCalls,
		turns: failed.turns + current.turns,
		dirty: failed.dirty || current.dirty,
	};
}
