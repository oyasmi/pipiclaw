import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { FileLockTimeoutError, withFileLock } from "../shared/file-lock.js";
import { formatLocalTime } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { normalizeTaskId } from "./contract.js";
import { appendTaskLog, readTaskLog } from "./loop-log.js";
import { withTaskMutation } from "./mutation-lock.js";

/** Task-owned outbound text, separate from archive lifetime. No model wake is needed to retry it. */
export interface TaskDelivery {
	id: string;
	taskId: string;
	channel: string;
	kind: "report" | "receipt";
	seq?: number;
	order: number;
	text: string;
	createdAt: string;
	attempts: number;
	nextAttemptAt: number;
	sentAt?: string;
}

export type TaskSender = (channel: string, text: string) => Promise<boolean>;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const ID_PATTERN = /^(?:close-)?[a-f0-9-]{36}$/;
const directory = (deskDir: string) => join(deskDir, "tasks", ".delivery");
const pathFor = (deskDir: string, id: string) => {
	if (!ID_PATTERN.test(id)) throw new Error("Invalid task delivery id; have the deployer inspect the delivery queue.");
	return join(directory(deskDir), `${id}.json`);
};

export async function readTaskDeliveries(deskDir: string): Promise<TaskDelivery[]> {
	let names: string[];
	try {
		names = await readdir(directory(deskDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const messages: TaskDelivery[] = [];
	for (const name of names.filter((name) => name.endsWith(".json"))) {
		const message = await readDelivery(deskDir, name.slice(0, -5));
		if (message) messages.push(message);
	}
	return messages.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.order - b.order);
}

async function readDelivery(deskDir: string, id: string): Promise<TaskDelivery | undefined> {
	const path = pathFor(deskDir, id);
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(raw);
	if (
		!isPlainObject(value) ||
		value.id !== id ||
		typeof value.taskId !== "string" ||
		normalizeTaskId(value.taskId) !== value.taskId ||
		typeof value.channel !== "string" ||
		(value.kind !== "report" && value.kind !== "receipt") ||
		typeof value.text !== "string" ||
		typeof value.createdAt !== "string" ||
		!Number.isInteger(value.order) ||
		!Number.isFinite(value.attempts) ||
		!Number.isFinite(value.nextAttemptAt) ||
		(value.kind === "report" && !Number.isInteger(value.seq)) ||
		(value.sentAt !== undefined && typeof value.sentAt !== "string")
	) {
		throw new Error(`Invalid task delivery: ${path}; have the deployer inspect it before retrying.`);
	}
	return value as unknown as TaskDelivery;
}

async function save(deskDir: string, message: TaskDelivery): Promise<void> {
	await writeFileAtomically(pathFor(deskDir, message.id), JSON.stringify(message));
}

/** Persist before any network operation; the same id joins the report and its receipt. */
export async function queueTaskReport(
	deskDir: string,
	taskId: string,
	seq: number,
	channel: string,
	text: string,
): Promise<TaskDelivery> {
	const message: TaskDelivery = {
		id: randomUUID(),
		taskId: normalizeTaskId(taskId),
		seq,
		channel,
		text,
		kind: "report",
		createdAt: formatLocalTime(),
		attempts: 0,
		nextAttemptAt: 0,
		order: 0,
	};
	await withTaskMutation(deskDir, taskId, async () => {
		if (
			!existsSync(join(deskDir, "tasks", `${message.taskId}.md`)) ||
			existsSync(join(deskDir, "tasks", ".closing", `${message.taskId}.json`))
		) {
			throw new RecoverableToolError(
				`Task "${taskId}" is no longer accepting reports. End this step and inspect task_list before starting further work.`,
			);
		}
		const records = await readTaskLog(deskDir, taskId, { strict: true });
		const queued = (await readTaskDeliveries(deskDir)).filter(
			(record) => record.taskId === taskId && record.kind === "report",
		);
		message.order = Math.max(
			seq * 4 + records.filter((record) => record.kind === "report" && record.seq === seq).length,
			...queued.map((record) => record.order + 1),
		);
		await save(deskDir, message);
		await recordReport(deskDir, message);
	});
	return message;
}

/** Caller holds the task lock; a stable close id makes retrying preparation idempotent. */
export async function queueTaskReceipt(
	deskDir: string,
	taskId: string,
	closeId: string,
	channel: string,
	text: string,
): Promise<void> {
	const id = `close-${closeId}`;
	if (await readDelivery(deskDir, id)) return;
	await save(deskDir, {
		id,
		taskId,
		channel,
		text,
		kind: "receipt",
		createdAt: formatLocalTime(),
		attempts: 0,
		nextAttemptAt: 0,
		order: Number.MAX_SAFE_INTEGER,
	});
}

async function recordReport(deskDir: string, message: TaskDelivery): Promise<void> {
	if ((await readTaskLog(deskDir, message.taskId, { strict: true })).some((record) => record.id === message.id))
		return;
	await appendTaskLog(deskDir, message.taskId, {
		kind: "report",
		id: message.id,
		ts: message.createdAt,
		seq: message.seq!,
		text: message.text,
		delivered: false,
		channel: message.channel,
	});
}

/** At-least-once: a crash between remote acceptance and sentAt persistence can repeat the same message. */
export async function deliverTaskMessage(
	deskDir: string,
	id: string,
	send: TaskSender,
	now = Date.now(),
): Promise<boolean> {
	pathFor(deskDir, id);
	try {
		return await withFileLock(
			join(deskDir, ".locks", `delivery-${id}.lock`),
			async () => {
				const message = await readDelivery(deskDir, id);
				if (!message) return true;
				if (message.nextAttemptAt > now) return false;
				const active = existsSync(join(deskDir, "tasks", `${message.taskId}.md`));
				if (message.kind === "receipt") {
					if (active || !existsSync(join(deskDir, "tasks", "archive", `${message.taskId}.md`))) return false;
				} else if (!active) {
					// Cancellation may discard undelivered progress. Never recreate an active log after archive.
					await rm(pathFor(deskDir, id), { force: true });
					return true;
				} else {
					await withTaskMutation(deskDir, message.taskId, () => recordReport(deskDir, message));
				}
				if (!message.sentAt) {
					message.attempts++;
					message.nextAttemptAt =
						now + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(message.attempts - 1, 4));
					await save(deskDir, message);
					try {
						if (!(await send(message.channel, message.text))) return false;
					} catch (error) {
						log.logWarn("tasks.delivery.send_failed", "Task delivery failed", {
							reason: errorMessage(error),
							channelId: message.channel,
							fields: { taskId: message.taskId, deliveryId: id },
						});
						return false;
					}
					message.sentAt = formatLocalTime(new Date(now));
					await save(deskDir, message);
				}
				if (message.kind === "report")
					await withTaskMutation(deskDir, message.taskId, async () => {
						if (!existsSync(join(deskDir, "tasks", `${message.taskId}.md`))) return;
						const records = await readTaskLog(deskDir, message.taskId, { strict: true });
						if (!records.some((record) => record.kind === "report_delivered" && record.reportId === id)) {
							await appendTaskLog(deskDir, message.taskId, {
								kind: "report_delivered",
								reportId: id,
								ts: message.sentAt,
							});
						}
						// Persist acknowledgment before deleting the retry record. Other task log writes
						// do not pay fsync on every append; delivery is a user-visible commit point.
						const handle = await open(join(deskDir, "tasks", `${message.taskId}.jsonl`), "r");
						try {
							await handle.sync();
						} finally {
							await handle.close();
						}
					});
				await rm(pathFor(deskDir, id), { force: true });
				return true;
			},
			{ timeoutMs: 1 },
		);
	} catch (error) {
		if (error instanceof FileLockTimeoutError) return false;
		throw error;
	}
}

/** FIFO per task; a failed progress message cannot be overtaken by its final delivery. */
export async function drainTaskDeliveries(
	deskDir: string,
	send: TaskSender,
	allowed: (channel: string) => boolean,
	now = Date.now(),
): Promise<number | undefined> {
	const blocked = new Set<string>();
	let next: number | undefined;
	for (const message of await readTaskDeliveries(deskDir)) {
		if (blocked.has(message.taskId) || !allowed(message.channel)) continue;
		if (!(await deliverTaskMessage(deskDir, message.id, send, now))) {
			blocked.add(message.taskId);
			const current = await readDelivery(deskDir, message.id);
			const at = Math.max(now + 1_000, current?.nextAttemptAt ?? now + RETRY_MIN_MS);
			next = Math.min(next ?? at, at);
		}
	}
	return next;
}
