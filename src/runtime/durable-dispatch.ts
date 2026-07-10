import { createHash } from "node:crypto";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { createSerialQueue } from "../shared/serial-queue.js";
import type { DingTalkBot, DingTalkEvent } from "./dingtalk.js";

type DispatchStatus = "pending" | "queued" | "running";

interface DurableDispatchRecord {
	version: 1;
	id: string;
	createdAt: string;
	status: DispatchStatus;
	event: DingTalkEvent;
	deliveries: number;
	leaseExpiresAt?: string;
}

export interface DurableDispatchOptions {
	stateDir: string;
	bot: Pick<DingTalkBot, "enqueueEvent">;
	leaseMs?: number;
	intervalMs?: number;
}

const DEFAULT_LEASE_MS = 15 * 60_000;
const DEFAULT_INTERVAL_MS = 30_000;

function recordPath(stateDir: string, id: string): string {
	return join(stateDir, `${id}.json`);
}

function dispatchId(event: DingTalkEvent): string {
	return createHash("sha256")
		.update(JSON.stringify([event.channelId, event.user, event.ts, event.text, event.conversationId]))
		.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseRecord(raw: string): DurableDispatchRecord | undefined {
	try {
		const value: unknown = JSON.parse(raw);
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			typeof value.id !== "string" ||
			typeof value.createdAt !== "string" ||
			(value.status !== "pending" && value.status !== "queued" && value.status !== "running") ||
			!isRecord(value.event) ||
			typeof value.event.channelId !== "string" ||
			typeof value.event.text !== "string" ||
			typeof value.deliveries !== "number"
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

	constructor(private readonly options: DurableDispatchOptions) {
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	}

	start(): void {
		if (this.timer) return;
		void this.drainOnce();
		this.timer = setInterval(() => void this.drainOnce(), this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	async dispatch(event: DingTalkEvent): Promise<boolean> {
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
		await this.drainOnce();
		return true;
	}

	async markStarted(id: string | undefined): Promise<void> {
		if (!id) return;
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
		await this.queue.run(id, async () => {
			await unlink(recordPath(this.options.stateDir, id)).catch(() => undefined);
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
			await this.queue.run(id, async () => {
				const record = await this.read(id);
				if (!record) return;
				const leaseMs = record.leaseExpiresAt ? new Date(record.leaseExpiresAt).getTime() : undefined;
				if ((record.status === "queued" || record.status === "running") && leaseMs && leaseMs > now) return;
				record.status = "queued";
				record.deliveries++;
				record.leaseExpiresAt = new Date(now + this.leaseMs).toISOString();
				await this.write(record);
				const accepted = this.options.bot.enqueueEvent({ ...record.event, dispatchId: record.id });
				if (accepted) return;
				record.status = "pending";
				record.leaseExpiresAt = undefined;
				await this.write(record);
			});
		}
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
