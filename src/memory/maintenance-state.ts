import { readFile, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getChannelDirName } from "../channel/channel-paths.js";
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

export type MemoryActivityKind = "user-turn-started" | "tool-call" | "assistant-turn-completed" | "boundary";

export interface MemoryActivityEvent {
	kind: MemoryActivityKind;
	channelId: string;
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

/**
 * One flat file per channel, named by the same escaped form directories use.
 *
 * The id goes into a filename here, and a DingTalk group id routinely contains `/`, so writing
 * it raw put the file in a subdirectory of the state dir — `group_a/b==.json`. Reads and writes
 * agreed, so nothing was lost, but {@link getMemoryMaintenanceStateDir}'s only listing walks the
 * top level: every such channel was invisible to the scheduler's state-derived discovery.
 */
export function getMemoryMaintenanceStatePath(appHomeDir: string, channelId: string): string {
	return join(getMemoryMaintenanceStateDir(appHomeDir), `${getChannelDirName(channelId)}.json`);
}

/**
 * Where a pre-escaping runtime put the same channel's state. Only differs for ids containing
 * `/`, and only matters until the next write moves the state to its canonical path.
 *
 * RETIRE AT v0.9.3, same rationale as the header comment in `../runtime/task-migration.js`: by
 * the stable cut, every still-running group channel with a `/` in its id will have had its state
 * folded onto the canonical path at least once, so this fallback read finds nothing.
 */
function legacyStatePath(appHomeDir: string, channelId: string): string | undefined {
	return getChannelDirName(channelId) === channelId
		? undefined
		: join(getMemoryMaintenanceStateDir(appHomeDir), `${channelId}.json`);
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
		// v1 states carried the checkpoint job's fields under a different name; fold them into
		// the reflect cadence/cursor so an upgrade does not re-run reflect on the channel's whole
		// history nor lose its due time.
		lastReflectAt: normalizeOptionalString(record.lastReflectAt) ?? normalizeOptionalString(record.lastCheckpointAt),
		lastReflectedEntryId:
			normalizeOptionalString(record.lastReflectedEntryId) ?? normalizeOptionalString(record.lastCheckpointEntryId),
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
			const legacy = await readLegacyState(appHomeDir, channelId);
			return legacy ?? createDefaultState(channelId);
		}
		const message = errorMessage(error);
		log.logWarning(`[${channelId}] Failed to read memory maintenance state; rebuilding defaults`, message);
		return createDefaultState(channelId);
	}
}

async function readLegacyState(appHomeDir: string, channelId: string): Promise<MemoryMaintenanceState | undefined> {
	const path = legacyStatePath(appHomeDir, channelId);
	if (!path) return undefined;
	try {
		return normalizeState(channelId, JSON.parse(await readFile(path, "utf-8")) as unknown);
	} catch {
		return undefined; // absent or unreadable ⇒ the caller falls back to defaults, as before
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
		// The canonical file now holds everything the legacy one did; leaving it would keep a
		// stale copy around forever, since reads only fall back when the canonical file is gone.
		const legacy = legacyStatePath(appHomeDir, channelId);
		if (legacy) {
			await unlink(legacy).catch(() => {});
			// ...along with the directory the raw id created, which `rmdir` leaves alone if
			// another channel's state still lives there. Tidying only; failure changes nothing.
			const strayDir = dirname(legacy);
			if (strayDir !== getMemoryMaintenanceStateDir(appHomeDir)) await rmdir(strayDir).catch(() => {});
		}
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
	return applyPendingActivityToState(state, event.channelId, mergeMemoryActivity(undefined, event));
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
		dirty: failed.dirty || current.dirty,
	};
}
