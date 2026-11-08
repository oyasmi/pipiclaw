/**
 * The durable outbox for synthetic events (job and delegation completions, task wakes, scheduled events):
 * records are written to disk before they enter the in-memory channel queue, leased, retried and
 * redelivered after a crash — at-least-once.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelEventSink, WakeEvent } from "../channel/channel-event.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";

type DispatchStatus = "pending" | "queued" | "running" | "exhausted";

export interface DurableDispatchRecord {
	version: 1;
	id: string;
	createdAt: string;
	status: DispatchStatus;
	event: WakeEvent;
	deliveries: number;
	leaseExpiresAt?: string;
	/** Set by `markRetryable` to back off a repeatedly-failing structured wake instead of
	 * redelivering on the very next drain tick (spec 031's redelivery has no such gate). */
	nextAttemptAt?: string;
}

export interface DurableDispatchOptions {
	stateDir: string;
	bot: ChannelEventSink;
	/**
	 * Whether the channel's transport is switched on in this process (spec 061, INV-8). A record for
	 * a transport that is off is not delivered and not counted against its delivery limit: it stays
	 * on disk until a run in which the transport is back.
	 */
	isReachable?: (channelId: string) => boolean;
	leaseMs?: number;
	intervalMs?: number;
	/** Called once, at most, when a dispatch id hits `MAX_DELIVERIES` without ever completing —
	 * e.g. a structured wake whose claim/finish step fails deterministically (disk full,
	 * permissions). The record is left on disk (not deleted) so the failure is inspectable; the
	 * caller is expected to notify the channel. */
	onExhausted?: (record: DurableDispatchRecord) => void | Promise<void>;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 30_000;
/** Total delivery attempts (crash-lease redelivery and `markRetryable` failures combined) before
 * a dispatch id is given up on as a poison pill rather than retried forever. */
const MAX_DELIVERIES = 8;
const MIN_RETRY_BACKOFF_MS = 30_000;
const MAX_RETRY_BACKOFF_MS = 10 * 60_000;

/**
 * A dispatch id is an opaque business id and may contain `/`. Used verbatim as a filename it would
 * turn into a nested path a flat `readdir(stateDir)` scan can never find again (R1): a queue
 * rejection or a restart then makes that record un-drainable and un-cancellable forever, even once
 * capacity returns. Percent-encoding makes it always a flat filename and reversible without
 * collisions, without touching the id itself — only the on-disk filename changes.
 */
function encodeDispatchId(id: string): string {
	return encodeURIComponent(id);
}

/** Inverse of {@link encodeDispatchId}. */
function decodeDispatchId(encoded: string): string {
	try {
		return decodeURIComponent(encoded);
	} catch {
		return encoded;
	}
}

function recordPath(stateDir: string, id: string): string {
	return join(stateDir, `${encodeDispatchId(id)}.json`);
}

/**
 * Prefix a redelivered wake with what the runtime already knows (spec 031, D3).
 *
 * At-least-once delivery means a wake can arrive after a previous attempt already ran part of
 * it. The runtime knows this; the model did not. Surfacing the delivery count is the whole
 * mechanism — no new protocol, no reply marker, just enough for the model to check for its own
 * prior side effects before repeating them. The stored record keeps the original text, so the
 * dispatch id is unaffected.
 */
function withRedeliveryNotice(event: WakeEvent, deliveries: number): WakeEvent {
	if (deliveries <= 1) return event;
	return {
		...event,
		text:
			`[REDELIVERY:${deliveries}] This wake is delivery #${deliveries}; a previous delivery may have partially run. ` +
			"Before acting, check whether its side effects (files, messages, external calls) already exist, and do not repeat them.\n" +
			event.text,
	};
}

/**
 * What a wake was for, in the user's terms (spec 053, D2). The wake's own `text` is a prompt for
 * the model and its `producer` an internal tag (`SUBAGENT`, `JOB`, …), so neither
 * may reach the chat; every in-process producer prefixes its text with a `[KIND:id…]` tag, which
 * is what this reads instead.
 */
function describeWakeSource(event: WakeEvent): { label: string; nextStep?: string } {
	const tag = /^\[(SUBAGENT|JOB|EVENT):([^:\]\s]+)/.exec(event.text);
	const id = tag?.[2];
	switch (tag?.[1]) {
		case "SUBAGENT":
			return { label: `委派 \`${id}\` 的完成通知`, nextStep: `用 \`/subagents show ${id}\` 查看结果` };
		case "JOB":
			return { label: `后台作业 \`${id}\` 的完成通知`, nextStep: "需要时让我查看这个作业的结果" };
		case "EVENT": {
			const name = id?.replace(/\.json$/, "");
			return { label: `定时事件 \`${name}\` 的一次触发`, nextStep: `用 \`/events history ${name}\` 查看触发记录` };
		}
		default:
			return { label: "一次后台唤醒" };
	}
}

/**
 * The notice a channel gets when a wake is given up on (`onExhausted`). It names the source and
 * the record's absolute path — never the wake text, which is a model prompt (spec 053, D2/D6).
 */
export function renderDispatchExhaustedNotice(record: DurableDispatchRecord, stateDir: string): string {
	const source = describeWakeSource(record.event);
	const where = `排查记录在 \`${recordPath(stateDir, record.id)}\``;
	return (
		`⚠️ ${source.label}连续 ${record.deliveries} 次未能完成，已停止重试。\n` +
		(source.nextStep ? `${source.nextStep}；${where}。` : `${where}。`)
	);
}

function dispatchId(event: WakeEvent): string {
	return createHash("sha256")
		.update(JSON.stringify([event.channelId, event.producer, event.ts, event.text]))
		.digest("hex");
}

class CorruptDispatchError extends Error {}

function parseRecord(raw: string, id: string): DurableDispatchRecord {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (cause) {
		throw new CorruptDispatchError("Invalid dispatch JSON; have the deployer inspect the record.", { cause });
	}
	const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
	if (
		!isPlainObject(value) ||
		value.version !== 1 ||
		value.id !== id ||
		!date(value.createdAt) ||
		typeof value.status !== "string" ||
		!["pending", "queued", "running", "exhausted"].includes(value.status) ||
		!isPlainObject(value.event) ||
		value.event.source !== "wake" ||
		typeof value.event.channelId !== "string" ||
		!value.event.channelId ||
		typeof value.event.desk !== "string" ||
		!value.event.desk ||
		typeof value.event.ts !== "string" ||
		!value.event.ts ||
		typeof value.event.producer !== "string" ||
		!value.event.producer ||
		(value.event.presentation !== undefined && value.event.presentation !== "awaited") ||
		(value.event.images !== undefined &&
			(!Array.isArray(value.event.images) ||
				value.event.images.some(
					(image: unknown) =>
						!isPlainObject(image) ||
						typeof image.path !== "string" ||
						typeof image.mimeType !== "string" ||
						!Number.isSafeInteger(image.byteSize) ||
						(image.byteSize as number) < 0 ||
						(image.unsupportedFormat !== undefined && typeof image.unsupportedFormat !== "boolean"),
				))) ||
		typeof value.event.text !== "string" ||
		value.event.dispatchId !== id ||
		!Number.isSafeInteger(value.deliveries) ||
		(value.deliveries as number) < 0 ||
		(value.nextAttemptAt !== undefined && !date(value.nextAttemptAt)) ||
		(value.leaseExpiresAt !== undefined && !date(value.leaseExpiresAt))
	) {
		throw new CorruptDispatchError("Invalid dispatch structure; have the deployer inspect the record.");
	}
	return value as unknown as DurableDispatchRecord;
}

/**
 * Tiny file-backed outbox for synthetic work. It intentionally provides
 * at-least-once delivery: a crash after enqueue may replay a task/event, while
 * a crash can no longer silently discard it merely because it left an in-memory
 * channel queue.
 */
export class DurableDispatchService {
	private stopped = false;
	private readonly capacityRejected = new Map<string, Set<string>>();
	private readonly capacityDrains = new Map<string, { dirty: boolean }>();
	private readonly queue = createSerialQueue<string>();
	private readonly pendingWrites = new Set<Promise<unknown>>();

	private run<T>(id: string, work: () => Promise<T>): Promise<T> {
		const pending = this.queue.run(id, work);
		this.pendingWrites.add(pending);
		void pending.finally(() => this.pendingWrites.delete(pending)).catch(() => undefined);
		return pending;
	}

	/** stop() closes background admission; after active turns settle, wait for started writes
	 * before another process can acquire the daemon lock. A hung write keeps that lock retained. */
	async flush(): Promise<void> {
		await Promise.allSettled([...this.pendingWrites]);
	}
	private readonly leaseMs: number;
	private timer: ReturnType<typeof setInterval> | null = null;
	/**
	 * Dispatch ids whose turn this process is still running (spec 031, D2).
	 *
	 * The lease expresses "the holder is alive", not "a turn takes at most N minutes". A fixed
	 * lease is a guess about turn duration, and any turn that outran it redelivered its own wake.
	 * Membership here is renewed on every drain instead, so a long turn is safe; the set is empty
	 * after a restart, so a turn that died with the process is correctly redelivered once its
	 * lease lapses.
	 */
	private readonly running = new Set<string>();
	/**
	 * Queued dispatch ids folded into another record's turn by `absorbPending`. Each still has its
	 * own closure waiting in the channel queue; `markStarted` turns that stale delivery away instead
	 * of running the same wake a second time.
	 */
	private readonly absorbed = new Map<string, string>();
	/** Bumped by `discardQueuedClaims`; lets an in-flight `absorbPending` notice that its closures were dropped. */
	private readonly discardEpoch = new Map<string, number>();
	constructor(private readonly options: DurableDispatchOptions) {
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	}

	start(): void {
		if (this.timer) return;
		this.stopped = false;
		this.drainSafely();
		this.timer = setInterval(() => this.drainSafely(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
		this.timer.unref?.();
	}

	/**
	 * The drain is timer-driven, so nothing above it can catch a rejection: a record write that
	 * fails (ENOSPC, EACCES) would take the process down rather than skip one tick. The next
	 * tick retries from the same persisted state, which is the whole point of the store.
	 */
	private drainSafely(): void {
		this.drainOnce().catch((error) => {
			log.logWarn("dispatch.drain.failed", "Durable dispatch drain failed", { reason: errorMessage(error) });
		});
	}

	stop(): void {
		this.stopped = true;
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/** Capacity is only a scheduling hint; every retry still reads disk under the per-id lock. */
	notifyCapacity(channelId: string): void {
		if (this.stopped || !this.capacityRejected.get(channelId)?.size) return;
		const current = this.capacityDrains.get(channelId);
		if (current) {
			current.dirty = true;
			return;
		}
		const drain = { dirty: true };
		this.capacityDrains.set(channelId, drain);
		setImmediate(() => {
			void (async () => {
				do {
					drain.dirty = false;
					for (const id of [...(this.capacityRejected.get(channelId) ?? [])]) {
						if (this.stopped) return;
						try {
							await this.drainRecord(id, Date.now());
						} catch (error) {
							this.reportRecordFault(id, error);
						}
					}
				} while (drain.dirty && !this.stopped);
			})()
				.catch((error) =>
					log.logWarn("dispatch.capacity.failed", "Capacity retry failed", {
						channelId,
						reason: errorMessage(error),
					}),
				)
				.finally(() => this.capacityDrains.delete(channelId));
		});
	}

	private trackRejected(channelId: string, id: string): void {
		let ids = this.capacityRejected.get(channelId);
		if (!ids) {
			ids = new Set();
			this.capacityRejected.set(channelId, ids);
		}
		ids.add(id);
	}

	private untrack(id: string): void {
		for (const [channel, ids] of this.capacityRejected) {
			ids.delete(id);
			if (!ids.size) this.capacityRejected.delete(channel);
		}
	}

	async dispatch(event: WakeEvent): Promise<boolean> {
		if (this.stopped) return false;
		// Spec 058, D7: every in-process producer stamps its desk. An event without one cannot be
		// checked against the channel's binding at admission, so it is refused here, at the door.
		if (!event.desk) {
			log.logWarn("dispatch.event.missing_desk", "Dispatch refused: synthetic event carries no desk", {
				channelId: event.channelId,
				fields: { dispatchId: event.dispatchId, producer: event.producer },
			});
			return false;
		}
		const id = event.dispatchId ?? dispatchId(event);
		await this.run(id, async () => {
			const existing = await this.read(id);
			if (existing) return;
			const record: DurableDispatchRecord = {
				version: 1,
				id,
				createdAt: new Date().toISOString(),
				status: "pending",
				event: { ...event, dispatchId: id },
				deliveries: 0,
			};
			await this.write(record);
		});
		// Only this record needs draining here — a full directory scan would pay for every other
		// channel's outstanding record just to learn the outcome of the one just written.
		await this.drainRecord(id, Date.now());
		// The record is gone (delivered+completed already) or no longer "pending"
		// (drainRecord only reverts to "pending" when bot.enqueueEvent rejected it). "exhausted"
		// is reported as not-accepted too: the poison pill is durably recorded and its owner
		// notified via onExhausted, but this dispatch id will never be delivered again.
		const after = await this.read(id);
		if (!after) return true;
		return after.status !== "pending" && after.status !== "exhausted";
	}

	/** Reset any in-flight records for a channel so a stop/abort can redeliver on the next tick, not after the lease expires. */
	async cancelChannel(channelId: string): Promise<number> {
		let filenames: string[];
		try {
			filenames = (await readdir(this.options.stateDir)).filter((name) => name.endsWith(".json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
		let canceled = 0;
		for (const filename of filenames) {
			if (this.stopped) break;
			const id = this.idFromFilename(filename);
			if (id === undefined) continue;
			try {
				await this.run(id, async () => {
					const record = await this.read(id);
					if (!record || record.event.channelId !== channelId) return;
					if (record.status !== "queued" && record.status !== "running") return;
					// Drop the liveness claim too, or the renew branch above would keep this record
					// alive forever and the cancelled turn would never be redelivered.
					this.running.delete(id);
					// `/stop` already dropped the queued closures; the redelivery must not be turned away.
					this.absorbed.delete(id);
					record.leaseExpiresAt = undefined;
					await this.write(record);
					canceled++;
				});
			} catch (error) {
				this.reportRecordFault(id, error);
			}
		}
		return canceled;
	}

	/**
	 * `/stop` just cleared the channel's queued closures, synchronously and before any await, so
	 * no queued delivery of an absorbed wake survives to consume its stale-delivery mark. Dropping
	 * the marks here records that fact at the moment it is true, independent of when (or whether)
	 * `cancelChannel` and the turn's own finish run. Not for non-stop failures: there the closures
	 * are alive and the marks are what prevents a duplicate run.
	 */
	/** Opaque `/stop` counter; sample it synchronously at admission entry and hand it to `absorbPending`. */
	stopEpoch(channelId: string): number {
		return this.discardEpoch.get(channelId) ?? 0;
	}

	discardQueuedClaims(channelId: string): void {
		this.discardEpoch.set(channelId, (this.discardEpoch.get(channelId) ?? 0) + 1);
		for (const [id, owner] of this.absorbed) if (owner === channelId) this.absorbed.delete(id);
	}

	/**
	 * Claim a dispatch for the turn about to run it. Returns false — run nothing — for a stale
	 * delivery of a record another turn already absorbed (see `absorbPending`).
	 */
	async markStarted(id: string | undefined): Promise<boolean> {
		if (!id) return true;
		if (this.absorbed.delete(id)) return false;
		await this.run(id, async () => {
			const record = await this.read(id);
			if (!record) return;
			record.status = "running";
			record.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
			await this.write(record);
			this.running.add(id);
		});
		return true;
	}

	/**
	 * Fold other not-yet-started dispatches of `channelId` that `accept` into the turn that is
	 * starting `primaryId`, oldest first, at most `limit` of them. Each one is claimed exactly as
	 * `markStarted` would claim it (running, leased, counted as a delivery), so the caller must
	 * finish every returned id with `markCompleted` / `markRetryable` alongside the primary — and a
	 * crash mid-turn redelivers each of them on its own, unchanged. Returned events carry their
	 * own redelivery notice, like a normal delivery would.
	 */
	async absorbPending(
		channelId: string,
		primaryId: string,
		accept: (event: WakeEvent) => boolean,
		limit: number,
		/** `stopEpoch` sampled when the caller's admission began; a later `/stop` suppresses the stale-delivery marks. */
		epoch = this.stopEpoch(channelId),
	): Promise<WakeEvent[]> {
		if (limit <= 0) return [];
		let filenames: string[];
		try {
			filenames = (await readdir(this.options.stateDir)).filter((name) => name.endsWith(".json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const candidates: Array<{ id: string; createdAt: string }> = [];
		for (const filename of filenames) {
			const id = this.idFromFilename(filename);
			if (id === undefined) continue;
			if (id === primaryId || this.running.has(id)) continue;
			try {
				const record = await this.read(id);
				if (record && this.isAbsorbable(record, channelId, accept))
					candidates.push({ id, createdAt: record.createdAt });
			} catch (error) {
				this.reportRecordFault(id, error);
			}
		}
		candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		const events: WakeEvent[] = [];
		for (const { id } of candidates.slice(0, limit)) {
			try {
				await this.run(id, async () => {
					// Re-checked under the record's own lock: a drain or its own delivery may have moved it.
					const record = await this.read(id);
					if (!record || this.running.has(id) || !this.isAbsorbable(record, channelId, accept)) return;
					const wasQueued = record.status === "queued";
					if (!wasQueued) record.deliveries++;
					record.status = "running";
					record.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
					record.nextAttemptAt = undefined;
					await this.write(record);
					// Publish in-process claims only after persistence succeeds. A failed write
					// must leave the original queued delivery / pending drain eligible to run.
					// Unless /stop dropped the closure meanwhile: then there is nothing left to turn away.
					if (wasQueued && this.stopEpoch(channelId) === epoch) this.absorbed.set(id, channelId);
					this.running.add(id);
					this.untrack(id);
					events.push(withRedeliveryNotice({ ...record.event, dispatchId: record.id }, record.deliveries));
				});
			} catch (error) {
				log.logWarn("dispatch.wake.absorb_failed", "Wake coalescing failed", {
					channelId,
					reason: errorMessage(error),
					fields: { dispatchId: id },
				});
				// Earlier claims still belong to this turn: return them for processing and
				// settlement instead of losing their ids through the caller's catch(() => []).
				break;
			}
		}
		return events;
	}

	/** Not started anywhere: still waiting for delivery (`pending`) or queued behind the current turn. */
	private isAbsorbable(
		record: DurableDispatchRecord,
		channelId: string,
		accept: (event: WakeEvent) => boolean,
	): boolean {
		return (
			record.event.channelId === channelId &&
			(record.status === "pending" || record.status === "queued") &&
			record.deliveries < MAX_DELIVERIES &&
			accept(record.event)
		);
	}

	async markCompleted(id: string | undefined): Promise<void> {
		if (!id) return;
		this.running.delete(id);
		this.untrack(id);
		await this.run(id, async () => {
			if (!(await this.read(id))) return;
			try {
				await unlink(recordPath(this.options.stateDir, id));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		});
	}

	/** Release a failed handler's in-process claim without deleting its durable record. Structured
	 * wake activation uses this for transient task/job/run persistence failures so the next drain
	 * can retry the same dispatch id instead of losing the only completion signal.
	 *
	 * A failure here means the handler itself is broken for this wake (a claim or finish step
	 * threw), not that the outbox lost a race — redelivering on the very next 30s tick would just
	 * repeat the same failure forever. Back off exponentially by delivery count instead; `deliveries`
	 * doubles as the poison-pill counter in `drainRecord`, so a wake that keeps failing here still
	 * eventually hits `MAX_DELIVERIES` and stops. */
	async markRetryable(id: string | undefined): Promise<void> {
		if (!id) return;
		this.running.delete(id);
		await this.run(id, async () => {
			const record = await this.read(id);
			if (!record) return;
			const backoffMs = Math.min(
				MIN_RETRY_BACKOFF_MS * 2 ** Math.max(0, record.deliveries - 1),
				MAX_RETRY_BACKOFF_MS,
			);
			record.status = "pending";
			record.leaseExpiresAt = undefined;
			record.nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
			await this.write(record);
		});
	}

	async drainOnce(now = Date.now()): Promise<void> {
		let filenames: string[];
		try {
			filenames = (await readdir(this.options.stateDir)).filter((name) => name.endsWith(".json")).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const filename of filenames) {
			if (this.stopped) break;
			const id = this.idFromFilename(filename);
			if (id === undefined) continue;
			try {
				await this.drainRecord(id, now);
			} catch (error) {
				this.reportRecordFault(id, error);
			}
		}
	}

	private async drainRecord(id: string, now: number): Promise<void> {
		if (this.stopped) return;
		await this.run(id, async () => {
			if (this.stopped) return;
			const record = await this.read(id);
			if (this.stopped) return;
			if (!record) {
				this.untrack(id);
				return;
			}
			if (record.status === "pending") this.trackRejected(record.event.channelId, id);
			// A poison pill: give up on redelivery for good, once. Left on disk (not deleted) so
			// `onExhausted`'s notice stays inspectable and the record is available for manual retry.
			if (record.status === "exhausted") {
				this.untrack(id);
				return;
			}
			// The turn is still running in this process: renew its lease rather than treating a
			// long turn as a lost one and redelivering the wake underneath it (D2).
			if (record.status === "running" && this.running.has(id)) {
				const currentLeaseMs = record.leaseExpiresAt ? new Date(record.leaseExpiresAt).getTime() : 0;
				// Only persist the renewal once the lease is more than halfway to expiry, instead of
				// on every drain tick — a live holder gets rediscovered by the next tick regardless,
				// so there is no correctness reason to fsync a rename this often.
				if (currentLeaseMs - now < this.leaseMs / 2) {
					record.leaseExpiresAt = new Date(now + this.leaseMs).toISOString();
					await this.write(record);
				}
				return;
			}
			const leaseMs = record.leaseExpiresAt ? new Date(record.leaseExpiresAt).getTime() : undefined;
			if ((record.status === "queued" || record.status === "running") && leaseMs && leaseMs > now) return;
			// markRetryable's backoff window; a plain enqueueEvent-rejected "pending" (no
			// nextAttemptAt) still retries on the very next tick, as before.
			const nextAttemptMs = record.nextAttemptAt ? new Date(record.nextAttemptAt).getTime() : undefined;
			if (record.status === "pending" && nextAttemptMs && nextAttemptMs > now) return;
			if (this.options.isReachable && !this.options.isReachable(record.event.channelId)) return;
			if (record.deliveries >= MAX_DELIVERIES) {
				record.status = "exhausted";
				this.untrack(id);
				record.leaseExpiresAt = undefined;
				record.nextAttemptAt = undefined;
				await this.write(record);
				try {
					await this.options.onExhausted?.(record);
				} catch (err) {
					log.logWarn("dispatch.exhausted_handler.failed", "Exhausted-dispatch handler failed", {
						reason: errorMessage(err),
						fields: { dispatchId: id },
					});
				}
				return;
			}
			record.status = "queued";
			record.deliveries++;
			record.leaseExpiresAt = new Date(now + this.leaseMs).toISOString();
			record.nextAttemptAt = undefined;
			await this.write(record);
			const accepted = this.options.bot.enqueueEvent(
				withRedeliveryNotice({ ...record.event, dispatchId: record.id }, record.deliveries),
			);
			if (accepted) {
				this.untrack(id);
				return;
			}
			this.trackRejected(record.event.channelId, id);
			// Admission rejection (queue full, bot stopped) is backpressure, not a delivery attempt —
			// the handler never ran and never got a chance to fail (R2). Counting it against
			// MAX_DELIVERIES meant a few minutes of congestion permanently exhausted a record that
			// was never actually tried; undo the increment above so only real handler outcomes
			// (markCompleted/markRetryable, or a crash-lease redelivery) count toward the poison-pill
			// limit.
			record.status = "pending";
			record.deliveries--;
			record.leaseExpiresAt = undefined;
			await this.write(record);
		});
	}

	private idFromFilename(filename: string): string | undefined {
		const id = decodeDispatchId(filename.slice(0, -".json".length));
		if (`${encodeDispatchId(id)}.json` === filename) return id;
		log.logWarn("dispatch.record.failed", "Dispatch record failed", {
			reason: "Invalid dispatch filename; have the deployer inspect the record.",
			fields: { path: join(this.options.stateDir, filename), classification: "corrupt" },
		});
		return undefined;
	}

	private reportRecordFault(id: string, error: unknown): void {
		log.logWarn("dispatch.record.failed", "Dispatch record failed", {
			reason: errorMessage(error),
			fields: {
				dispatchId: id,
				path: recordPath(this.options.stateDir, id),
				classification: error instanceof CorruptDispatchError ? "corrupt" : "io",
				code: (error as NodeJS.ErrnoException).code,
			},
		});
	}

	private async read(id: string): Promise<DurableDispatchRecord | undefined> {
		let raw: string;
		try {
			raw = await readFile(recordPath(this.options.stateDir, id), "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		return parseRecord(raw, id);
	}

	private async write(record: DurableDispatchRecord): Promise<void> {
		await writeFileAtomically(recordPath(this.options.stateDir, record.id), `${JSON.stringify(record)}\n`);
	}
}
