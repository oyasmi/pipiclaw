import { createHash } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelEvent } from "../channel/channel-event.js";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import { errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { DingTalkBot } from "./dingtalk.js";

type DispatchStatus = "pending" | "queued" | "running" | "exhausted";

export interface DurableDispatchRecord {
	version: 1;
	id: string;
	createdAt: string;
	status: DispatchStatus;
	event: ChannelEvent;
	deliveries: number;
	leaseExpiresAt?: string;
	/** Set by `markRetryable` to back off a repeatedly-failing structured wake instead of
	 * redelivering on the very next drain tick (spec 031's redelivery has no such gate). */
	nextAttemptAt?: string;
}

export interface DurableDispatchOptions {
	stateDir: string;
	bot: Pick<DingTalkBot, "enqueueEvent">;
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

function recordPath(stateDir: string, id: string): string {
	return join(stateDir, `${id}.json`);
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
function withRedeliveryNotice(event: ChannelEvent, deliveries: number): ChannelEvent {
	if (deliveries <= 1) return event;
	return {
		...event,
		text:
			`[REDELIVERY:${deliveries}] This wake is delivery #${deliveries}; a previous delivery may have partially run. ` +
			"Before acting, check whether its side effects (files, messages, external calls) already exist, and do not repeat them.\n" +
			event.text,
	};
}

function dispatchId(event: ChannelEvent): string {
	return createHash("sha256")
		.update(JSON.stringify([event.channelId, event.user, event.ts, event.text, event.conversationId]))
		.digest("hex");
}

function parseRecord(raw: string): DurableDispatchRecord | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			typeof value.id !== "string" ||
			typeof value.createdAt !== "string" ||
			(value.status !== "pending" &&
				value.status !== "queued" &&
				value.status !== "running" &&
				value.status !== "exhausted") ||
			!isRecord(value.event) ||
			typeof value.event.channelId !== "string" ||
			typeof value.event.text !== "string" ||
			typeof value.deliveries !== "number" ||
			(value.nextAttemptAt !== undefined && typeof value.nextAttemptAt !== "string")
		) {
			return undefined;
		}
		return value as unknown as DurableDispatchRecord;
	} catch {
		return undefined;
	}
}

/**
 * Tiny file-backed outbox for synthetic work. It intentionally provides
 * at-least-once delivery: a crash after enqueue may replay a task/event, while
 * a crash can no longer silently discard it merely because it left an in-memory
 * channel queue.
 */
export class DurableDispatchService {
	private readonly queue = createSerialQueue<string>();
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

	constructor(private readonly options: DurableDispatchOptions) {
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	}

	start(): void {
		if (this.timer) return;
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
			log.logWarning("Durable dispatch drain failed", errorMessage(error));
		});
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async dispatch(event: ChannelEvent): Promise<boolean> {
		const id = event.dispatchId ?? dispatchId(event);
		await this.queue.run(id, async () => {
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
		} catch {
			return 0;
		}
		let canceled = 0;
		for (const filename of filenames) {
			const id = filename.slice(0, -".json".length);
			await this.queue.run(id, async () => {
				const record = await this.read(id);
				if (!record || record.event.channelId !== channelId) return;
				if (record.status !== "queued" && record.status !== "running") return;
				// Drop the liveness claim too, or the renew branch above would keep this record
				// alive forever and the cancelled turn would never be redelivered.
				this.running.delete(id);
				record.leaseExpiresAt = undefined;
				await this.write(record);
				canceled++;
			});
		}
		return canceled;
	}

	async markStarted(id: string | undefined): Promise<void> {
		if (!id) return;
		this.running.add(id);
		await this.queue.run(id, async () => {
			const record = await this.read(id);
			if (!record) return;
			record.status = "running";
			record.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
			await this.write(record);
		});
	}

	async markCompleted(id: string | undefined): Promise<void> {
		if (!id) return;
		this.running.delete(id);
		await this.queue.run(id, async () => {
			await unlink(recordPath(this.options.stateDir, id)).catch(() => undefined);
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
		await this.queue.run(id, async () => {
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
		} catch {
			return;
		}
		for (const filename of filenames) {
			const id = filename.slice(0, -".json".length);
			await this.drainRecord(id, now);
		}
	}

	private async drainRecord(id: string, now: number): Promise<void> {
		await this.queue.run(id, async () => {
			const record = await this.read(id);
			if (!record) return;
			// A poison pill: give up on redelivery for good, once. Left on disk (not deleted) so
			// `onExhausted`'s notice stays inspectable and the record is available for manual retry.
			if (record.status === "exhausted") return;
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
			if (record.deliveries >= MAX_DELIVERIES) {
				record.status = "exhausted";
				record.leaseExpiresAt = undefined;
				record.nextAttemptAt = undefined;
				await this.write(record);
				try {
					await this.options.onExhausted?.(record);
				} catch (err) {
					log.logWarning(`Dispatch onExhausted handler failed for ${id}`, errorMessage(err));
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
			if (accepted) return;
			record.status = "pending";
			record.leaseExpiresAt = undefined;
			await this.write(record);
		});
	}

	private async read(id: string): Promise<DurableDispatchRecord | undefined> {
		try {
			return parseRecord(await readFile(recordPath(this.options.stateDir, id), "utf-8"));
		} catch {
			return undefined;
		}
	}

	private async write(record: DurableDispatchRecord): Promise<void> {
		await writeFileAtomically(recordPath(this.options.stateDir, record.id), `${JSON.stringify(record)}\n`);
	}
}
