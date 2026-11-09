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

export type TaskSender = (message: TaskDelivery) => Promise<boolean>;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const ID_PATTERN = /^(?:close-)?[a-f0-9-]{36}$/;
const directory = (deskDir: string) => join(deskDir, "tasks", ".delivery");
const pathFor = (deskDir: string, id: string) => {
	if (!ID_PATTERN.test(id)) throw new Error("Invalid task delivery id; have the deployer inspect the delivery queue.");
	return join(directory(deskDir), `${id}.json`);
};

interface DeliveryFault {
	path: string;
	taskId?: string;
	error: unknown;
}

/** Faults are retained in place. A known owner fences only that task; an unknowable owner
 * fences delivery globally because its FIFO predecessor relation cannot be established. */
async function scanDeliveries(deskDir: string): Promise<{ messages: TaskDelivery[]; faults: DeliveryFault[] }> {
	let names: string[];
	try {
		names = await readdir(directory(deskDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { messages: [], faults: [] };
		throw error;
	}
	const messages: TaskDelivery[] = [];
	const faults: DeliveryFault[] = [];
	for (const name of names.filter((name) => name.endsWith(".json"))) {
		try {
			const message = await readDelivery(deskDir, name.slice(0, -5));
			if (message) messages.push(message);
		} catch (error) {
			const taskId = undefined;
			const path = join(directory(deskDir), name);
			faults.push({ path, taskId, error });
		}
	}
	// The report journal independently records ownership. It can still identify a file whose
	// JSON is truncated or unreadable; never infer ownership from unparseable text fragments.
	if (faults.length) {
		const taskNames = new Set((await readdir(join(deskDir, "tasks"))).filter((name) => name.endsWith(".md")));
		try {
			for (const file of await readdir(join(deskDir, "tasks", "archive")))
				if (file.endsWith(".md")) taskNames.add(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		for (const file of taskNames) {
			const taskId = file.slice(0, -3);
			if (!validTaskId(taskId)) continue;
			try {
				const records = await readTaskLog(deskDir, taskId, { strict: true });
				for (const fault of faults) {
					if (
						!fault.taskId &&
						records.some(
							(record) =>
								(record.kind === "report" || record.kind === "close") &&
								fault.path ===
									join(directory(deskDir), `${record.kind === "close" ? "close-" : ""}${record.id}.json`),
						)
					)
						fault.taskId = taskId;
				}
			} catch (error) {
				log.logWarn("tasks.delivery.owner_failed", "Delivery ownership lookup failed", {
					reason: errorMessage(error),
					fields: { taskId },
				});
			}
		}
	}
	for (const { path, taskId, error } of faults)
		log.logWarn("tasks.delivery.read_failed", "Task delivery read failed", {
			reason: errorMessage(error),
			fields: {
				path,
				taskId,
				code: (error as NodeJS.ErrnoException).code,
				classification: error instanceof InvalidDeliveryError ? "corrupt" : "io",
			},
		});
	return { messages: messages.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.order - b.order), faults };
}

export async function readTaskDeliveries(deskDir: string): Promise<TaskDelivery[]> {
	const { messages, faults } = await scanDeliveries(deskDir);
	if (faults.length)
		throw new AggregateError(
			faults.map((fault) => fault.error),
			"Task delivery queue contains unreadable records; have the deployer inspect the logged paths.",
		);
	return messages;
}

class InvalidDeliveryError extends Error {
	constructor(path: string, cause?: unknown) {
		super(`Invalid task delivery: ${path}; have the deployer inspect it before retrying.`, { cause });
	}
}

function validTaskId(value: string): boolean {
	try {
		return normalizeTaskId(value) === value;
	} catch {
		return false;
	}
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
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch (error) {
		throw new InvalidDeliveryError(path, error);
	}
	if (
		!isPlainObject(value) ||
		value.id !== id ||
		typeof value.taskId !== "string" ||
		!validTaskId(value.taskId) ||
		typeof value.channel !== "string" ||
		(value.kind !== "report" && value.kind !== "receipt") ||
		typeof value.text !== "string" ||
		typeof value.createdAt !== "string" ||
		!Number.isSafeInteger(value.order) ||
		(value.order as number) < 0 ||
		!Number.isSafeInteger(value.attempts) ||
		(value.attempts as number) < 0 ||
		!Number.isFinite(value.nextAttemptAt) ||
		(value.nextAttemptAt as number) < 0 ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		(value.kind === "report" && (!Number.isSafeInteger(value.seq) || (value.seq as number) < 1)) ||
		(value.sentAt !== undefined && (typeof value.sentAt !== "string" || !Number.isFinite(Date.parse(value.sentAt))))
	) {
		throw new InvalidDeliveryError(path);
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
		const queued = (await scanDeliveries(deskDir)).messages.filter(
			(record) => record.taskId === taskId && record.kind === "report",
		);
		const reports = records.filter((record) => record.kind === "report");
		message.order = Math.max(
			...reports.map((record) => record.seq * 4 + reports.length),
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
						if (!(await send(message))) return false;
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
	const { messages, faults } = await scanDeliveries(deskDir);
	if (faults.length) next = now + RETRY_MIN_MS;
	if (faults.some((fault) => !fault.taskId)) return next;
	for (const fault of faults) blocked.add(fault.taskId!);
	for (const message of messages) {
		if (blocked.has(message.taskId)) continue;
		if (!allowed(message.channel)) {
			blocked.add(message.taskId);
			continue;
		}
		try {
			if (!(await deliverTaskMessage(deskDir, message.id, send, now))) {
				blocked.add(message.taskId);
				const current = await readDelivery(deskDir, message.id);
				const at = Math.max(now + 1_000, current?.nextAttemptAt ?? now + RETRY_MIN_MS);
				next = Math.min(next ?? at, at);
			}
		} catch (error) {
			blocked.add(message.taskId);
			next = Math.min(next ?? now + RETRY_MIN_MS, now + RETRY_MIN_MS);
			log.logWarn("tasks.delivery.drain_failed", "Task delivery drain failed", {
				reason: errorMessage(error),
				fields: { taskId: message.taskId, deliveryId: message.id, path: pathFor(deskDir, message.id) },
			});
		}
	}
	return next;
}
