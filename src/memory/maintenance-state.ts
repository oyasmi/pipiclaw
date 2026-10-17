import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DotConversation } from "../dot/types.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";

/** Spec 050, D9: one job (reflect), one small state shape. */
export interface MemoryMaintenanceState {
	channelId: string;
	dirty: boolean;
	lastActivityAt?: string;
	eligibleAfter?: string;
	lastReflectAt?: string;
	lastReflectedEntryId?: string;
	failureBackoffUntil?: string | null;
}

/**
 * Which conversation a maintenance state belongs to (spec 058, D12): reflect works one
 * conversation at a time, so its dirty flag, idle clock and checkpoint are per conversation.
 */
export type MaintenanceStateRef = Pick<DotConversation, "dot" | "conversation" | "channelId">;

export type MemoryActivityKind = "user-turn-started" | "tool-call" | "assistant-turn-completed" | "boundary";

export interface MemoryActivityEvent {
	kind: MemoryActivityKind;
	ref: MaintenanceStateRef;
	timestamp: string;
	eligibleAfter?: string;
}

/**
 * A run of activity events collapsed into the delta they would have produced: last-write-wins
 * for the timestamps, a sticky `dirty`. Associative, so an arbitrarily long burst folds into a
 * fixed-size delta — what lets the recorder below buffer a whole tool-heavy turn without growing.
 */
interface PendingMemoryActivity {
	lastActivityAt: string;
	eligibleAfter?: string;
	dirty: boolean;
}

const stateUpdateQueue = createSerialQueue<string>();

export function getMemoryMaintenanceStateDir(appHomeDir: string): string {
	return join(appHomeDir, "state", "memory");
}

/** `state/memory/<dot>/<conversation>.json`: both segments are validated names, never a channel id. */
export function getMemoryMaintenanceStatePath(appHomeDir: string, ref: MaintenanceStateRef): string {
	return join(getMemoryMaintenanceStateDir(appHomeDir), ref.dot, `${ref.conversation}.json`);
}

function refKey(ref: MaintenanceStateRef): string {
	return `${ref.dot}/${ref.conversation}`;
}

function createDefaultState(channelId: string): MemoryMaintenanceState {
	return { channelId, dirty: false, failureBackoffUntil: null };
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
		lastReflectAt: normalizeOptionalString(record.lastReflectAt),
		lastReflectedEntryId: normalizeOptionalString(record.lastReflectedEntryId),
		failureBackoffUntil: normalizeOptionalNullableString(record.failureBackoffUntil) ?? null,
	};
}

export async function readMemoryMaintenanceState(
	appHomeDir: string,
	ref: MaintenanceStateRef,
): Promise<MemoryMaintenanceState> {
	const { channelId } = ref;
	const path = getMemoryMaintenanceStatePath(appHomeDir, ref);
	try {
		const raw = await readFile(path, "utf-8");
		return normalizeState(channelId, JSON.parse(raw) as unknown);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
			return createDefaultState(channelId);
		}
		const message = errorMessage(error);
		log.logWarn("memory.state.read_failed", "Memory maintenance state unreadable; rebuilding defaults", {
			channelId: channelId,
			reason: message,
			fields: { dot: ref.dot, conversation: ref.conversation },
		});
		return createDefaultState(channelId);
	}
}

export async function updateMemoryMaintenanceState(
	appHomeDir: string,
	ref: MaintenanceStateRef,
	update: (state: MemoryMaintenanceState) => MemoryMaintenanceState,
): Promise<MemoryMaintenanceState> {
	const path = getMemoryMaintenanceStatePath(appHomeDir, ref);
	return stateUpdateQueue.run(path, async () => {
		const current = await readMemoryMaintenanceState(appHomeDir, ref);
		const next = normalizeState(ref.channelId, update(current));
		await writeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
		return next;
	});
}

function mergeMemoryActivity(
	pending: PendingMemoryActivity | undefined,
	event: MemoryActivityEvent,
): PendingMemoryActivity {
	const next: PendingMemoryActivity = pending ?? { lastActivityAt: event.timestamp, dirty: false };
	next.lastActivityAt = event.timestamp;
	next.eligibleAfter = event.eligibleAfter ?? next.eligibleAfter;
	if (event.kind === "tool-call" || event.kind === "assistant-turn-completed" || event.kind === "boundary") {
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
		dirty: state.dirty || pending.dirty,
	};
}

/** Apply a single activity event. The buffered path folds a whole burst through the same core. */
export function applyMemoryActivityToState(
	state: MemoryMaintenanceState,
	event: MemoryActivityEvent,
): MemoryMaintenanceState {
	return applyPendingActivityToState(state, event.ref.channelId, mergeMemoryActivity(undefined, event));
}

/**
 * Buffers activity events and writes them out in batches.
 *
 * Activity is recorded on *every* tool call, and each write used to be a read-modify-write of a
 * JSON file through `writeFileAtomically` — two fsyncs apiece. A thirty-step turn paid that thirty
 * times, on storage whose fsync latency the runtime does not control.
 *
 * Batching is safe because nothing consumes this state promptly: the reflect gate denies outright
 * while the channel is active, and `eligibleAfter` holds it off for `minIdleMinutesBeforeLlmWork`
 * after that. The scheduler then polls once a minute. So the state only has to be accurate by the
 * time a channel goes *idle* — which is why the runner also flushes explicitly at the end of every
 * turn, on top of the debounce here. The debounce bounds what a crash can lose to a few seconds of
 * `dirty`/`lastActivityAt`, never a reflect checkpoint: those are written directly, and the serial
 * queue keeps a flush from reordering against them.
 */
export interface MemoryActivityRecorder {
	record(event: MemoryActivityEvent): void;
	/** Write out buffered activity for one conversation, or for all of them when `ref` is omitted. */
	flush(ref?: MaintenanceStateRef): Promise<void>;
}

export const DEFAULT_ACTIVITY_FLUSH_DEBOUNCE_MS = 5_000;

export interface CreateMemoryActivityRecorderOptions {
	appHomeDir: string;
	/** Override the flush debounce; tests use a short one. */
	debounceMs?: number;
	onError?: (ref: MaintenanceStateRef, error: unknown) => void;
}

export function createMemoryActivityRecorder(options: CreateMemoryActivityRecorderOptions): MemoryActivityRecorder {
	const debounceMs = options.debounceMs ?? DEFAULT_ACTIVITY_FLUSH_DEBOUNCE_MS;
	const pending = new Map<string, PendingMemoryActivity>();
	const refs = new Map<string, MaintenanceStateRef>();
	const timers = new Map<string, NodeJS.Timeout>();
	/** The most recent write per conversation, so `flush` can await work another caller started. */
	const inFlight = new Map<string, Promise<void>>();

	const cancelTimer = (key: string): void => {
		const timer = timers.get(key);
		if (timer) {
			clearTimeout(timer);
			timers.delete(key);
		}
	};

	const flushConversation = (key: string): Promise<void> => {
		cancelTimer(key);
		const delta = pending.get(key);
		const ref = refs.get(key);
		if (!delta || !ref) {
			return inFlight.get(key) ?? Promise.resolve();
		}
		// Cleared before the await so events arriving during the write start a fresh batch
		// instead of being swallowed by this one.
		pending.delete(key);
		const write = updateMemoryMaintenanceState(options.appHomeDir, ref, (state) =>
			applyPendingActivityToState(state, ref.channelId, delta),
		)
			.then(() => undefined)
			.catch((error: unknown) => {
				// Put the delta back so the counters are not silently lost; the next event (or
				// flush) retries it, folded in front of anything buffered while this write ran.
				pending.set(key, mergeBack(delta, pending.get(key)));
				options.onError?.(ref, error);
			})
			.finally(() => {
				if (inFlight.get(key) === write) {
					inFlight.delete(key);
				}
			});
		inFlight.set(key, write);
		return write;
	};

	return {
		record(event: MemoryActivityEvent): void {
			const key = refKey(event.ref);
			refs.set(key, event.ref);
			pending.set(key, mergeMemoryActivity(pending.get(key), event));
			if (timers.has(key)) {
				return;
			}
			const timer = setTimeout(() => {
				timers.delete(key);
				void flushConversation(key);
			}, debounceMs);
			// Buffered counters are never a reason to keep the process alive.
			timer.unref?.();
			timers.set(key, timer);
		},

		async flush(ref?: MaintenanceStateRef): Promise<void> {
			const keys = ref ? [refKey(ref)] : new Set([...pending.keys(), ...inFlight.keys()]);
			await Promise.all([...keys].map((key) => flushConversation(key)));
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
		dirty: failed.dirty || current.dirty,
	};
}
