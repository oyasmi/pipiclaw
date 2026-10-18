import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { createUsage } from "./budget.js";
import { normalizeTaskId, renderTaskDocument, taskBody } from "./contract.js";
import {
	normalizeTaskFrontmatter,
	parseTaskFrontmatter,
	type TaskArchiveOutcome,
	type TaskFrontmatter,
	type TaskPaused,
} from "./frontmatter.js";
import { appendTaskLog, taskLogPath } from "./loop-log.js";
import { withTaskMutation } from "./mutation-lock.js";
import { describeTicket, type Ticket, ticketExpired } from "./ticket.js";

export interface StoredTaskDocument {
	id: string;
	path: string;
	fields: TaskFrontmatter;
	body: string;
}

/**
 * The contract's size target. The contract is injected whole into every step brief, so a long one
 * costs on every step. The runtime never rewrites the body (INV-6), so there is nothing it could
 * clip: a contract over the target is written as-is and warned about once per write.
 */
export const MAX_CONTRACT_BYTES = 4 * 1024;

export function tasksDir(dotDir: string): string {
	return join(dotDir, "tasks");
}

export function taskPath(dotDir: string, id: string): string {
	return join(tasksDir(dotDir), `${normalizeTaskId(id)}.md`);
}

export function archivedTaskPath(dotDir: string, id: string): string {
	return join(tasksDir(dotDir), "archive", `${normalizeTaskId(id)}.md`);
}

export async function readStoredTask(
	dotDir: string,
	idInput: string,
	includeArchive = false,
): Promise<StoredTaskDocument | undefined> {
	const id = normalizeTaskId(idInput);
	const activePath = taskPath(dotDir, id);
	const archivePath = archivedTaskPath(dotDir, id);
	const path = existsSync(activePath)
		? activePath
		: includeArchive && existsSync(archivePath)
			? archivePath
			: undefined;
	if (!path) return undefined;
	const content = await readFile(path, "utf-8");
	const parsed = parseTaskFrontmatter(content);
	return { id, path, fields: parsed.fields, body: taskBody(content) };
}

export async function writeStoredTask(document: StoredTaskDocument): Promise<void> {
	const fields = normalizeTaskFrontmatter(document.fields);
	const rendered = renderTaskDocument(fields, document.body);
	const size = Buffer.byteLength(rendered, "utf-8");
	if (size > MAX_CONTRACT_BYTES) {
		log.logWarn("tasks.contract.oversized", "Task contract exceeds its byte target; every step pays for it", {
			fields: { taskId: document.id, bytes: size, targetBytes: MAX_CONTRACT_BYTES },
		});
	}
	await writeFileAtomically(document.path, rendered);
}

export async function updateStoredTask(
	dotDir: string,
	id: string,
	update: (document: StoredTaskDocument) => void,
	includeArchive = false,
): Promise<StoredTaskDocument | undefined> {
	return withTaskMutation(dotDir, id, async () => {
		const document = await readStoredTask(dotDir, id, includeArchive);
		if (!document) return undefined;
		update(document);
		await writeStoredTask(document);
		return document;
	});
}

/**
 * Park a task on a ticket. The ticket must already have been through `resolveTicket` — this
 * function persists a decision, it does not make one.
 */
export async function parkTask(dotDir: string, id: string, ticket: Ticket): Promise<StoredTaskDocument | undefined> {
	return updateStoredTask(dotDir, id, (task) => {
		task.fields.state = "parked";
		task.fields.ticket = ticket;
	});
}

/**
 * Redeem a ticket: the single, idempotent transition from `parked` back to `open`.
 *
 * Idempotent by construction — a task that is no longer parked, or is parked on a *different*
 * ticket, is a no-op. That is what lets every producer (run settlement, job settlement, the
 * events watcher, `/tasks reply`, the driver's timer) push at-least-once without any of them
 * needing its own claim bookkeeping: the outermost wake-claim in `wake-claim.ts` still guards
 * duplicate delivery, and this guards duplicate application.
 */
export async function redeemTicket(
	dotDir: string,
	id: string,
	matches: (ticket: Ticket) => boolean,
): Promise<{ document: StoredTaskDocument; ticket: Ticket } | undefined> {
	let redeemed: Ticket | undefined;
	const document = await updateStoredTask(dotDir, id, (task) => {
		if (task.fields.state !== "parked" || !task.fields.ticket || task.fields.paused) return;
		if (!matches(task.fields.ticket)) return;
		redeemed = task.fields.ticket;
		task.fields.state = "open";
		task.fields.ticket = undefined;
		// The wait ended normally, so the "consecutive expiries" count starts over (spec 052, D3).
		if (task.fields.usage) task.fields.usage = { ...task.fields.usage, expired: 0 };
	});
	return document && redeemed ? { document, ticket: redeemed } : undefined;
}

/** Disable a task without losing its stage. `paused` present *is* the disabled state (D1). */
export async function pauseTask(
	dotDir: string,
	id: string,
	paused: Omit<TaskPaused, "at"> & { at?: string },
): Promise<StoredTaskDocument | undefined> {
	return updateStoredTask(dotDir, id, (task) => {
		task.fields.paused = { ...paused, at: paused.at ?? formatLocalTime() };
	});
}

/**
 * Lift a pause. A task that was paused *while parked on a ticket whose backstop has since passed*
 * (the double-expiry stop) is reopened and its expiry count cleared: the user has looked at it,
 * and resuming onto the same dead ticket would just expire — and pause — it a third time.
 */
export async function resumeTask(dotDir: string, id: string): Promise<StoredTaskDocument | undefined> {
	return updateStoredTask(dotDir, id, (task) => {
		task.fields.paused = undefined;
		if (task.fields.state === "parked" && task.fields.ticket && ticketExpired(task.fields.ticket)) {
			task.fields.state = "open";
			task.fields.ticket = undefined;
			if (task.fields.usage) task.fields.usage = { ...task.fields.usage, expired: 0 };
		}
	});
}

/**
 * The backstop transition (D2): a parked task whose `by` has passed goes back to `open` so its
 * next step can re-check reality, and the second consecutive expiry stops the task and
 * hands the user a deterministic receipt instead of burning another wake.
 *
 * Returns what the caller should do about it, or `undefined` when nothing applied.
 */
export type TicketExpiryOutcome = "reopened" | "paused";

export async function expireTicket(
	dotDir: string,
	id: string,
	limit = 2,
): Promise<{ document: StoredTaskDocument; outcome: TicketExpiryOutcome; ticket: string } | undefined> {
	let outcome: TicketExpiryOutcome | undefined;
	let summary = "";
	const document = await updateStoredTask(dotDir, id, (task) => {
		const ticket = task.fields.ticket;
		if (task.fields.state !== "parked" || !ticket || task.fields.paused) return;
		summary = describeTicket(ticket);
		const usage = task.fields.usage ?? createUsage();
		const expired = usage.expired + 1;
		task.fields.usage = { ...usage, expired };
		if (expired >= limit) {
			outcome = "paused";
			task.fields.paused = {
				by: "runtime",
				reason: `等待条件连续 ${expired} 次未满足：${summary}`,
				at: formatLocalTime(),
			};
			return;
		}
		outcome = "reopened";
		task.fields.state = "open";
		task.fields.ticket = undefined;
	});
	if (!document || !outcome) return undefined;
	await appendTaskLog(dotDir, id, {
		kind: "expired",
		ticket: summary,
		action: outcome,
	});
	return { document, outcome, ticket: summary };
}

const LOG_SUFFIXES = ["", ".1", ".2"] as const;

/**
 * `archiveTask` failed and could not fully put things back: `stranded` lists files that now live
 * only at the archive path (`<archive path> -> <original path>`), plus any archive contract it
 * could not remove. Callers must not delete anything archive-side on seeing this.
 */
export class ArchiveUndoError extends Error {
	constructor(
		readonly cause: unknown,
		readonly stranded: string[],
		readonly undoFailures: string[],
	) {
		super(
			`${errorMessage(cause)} (undo of partial archive failed: ${undoFailures.join("; ")}${
				stranded.length > 0 ? `; still at archive path, move back by hand: ${stranded.join(", ")}` : ""
			})`,
		);
	}
}

/**
 * Move a closed task (and its log) into `tasks/archive/`. It never overwrites an existing archive
 * entry (it throws before touching anything), and any failure after the first write undoes what it
 * did so the task stays fully active: a caller can trust "resolved" to mean the contract and every
 * log shard are in the archive, and "rejected" to mean the pre-call state still stands (or, if the
 * undo itself failed, the error says so).
 */
export function archiveTask(dotDir: string, id: string, outcome: TaskArchiveOutcome): Promise<void> {
	return withTaskMutation(dotDir, id, () => moveToArchive(dotDir, id, outcome));
}

async function moveToArchive(dotDir: string, id: string, outcome: TaskArchiveOutcome): Promise<void> {
	const normalized = normalizeTaskId(id);
	const archiveDir = join(tasksDir(dotDir), "archive");
	await mkdir(archiveDir, { recursive: true });
	const document = await readStoredTask(dotDir, normalized);
	if (!document) return;
	const archiveMd = archivedTaskPath(dotDir, normalized);
	const archiveLog = join(archiveDir, `${normalized}.jsonl`);
	for (const target of [archiveMd, ...LOG_SUFFIXES.map((suffix) => `${archiveLog}${suffix}`)]) {
		if (existsSync(target)) throw new Error(`archive entry already exists, refusing to overwrite: ${target}`);
	}
	document.fields.outcome = outcome;
	document.fields.closedAt = formatLocalTime();

	// The loop log travels with its contract so an archived task stays inspectable — including
	// whatever has already rotated into `.1`/`.2` (R9). Moving only the current file stranded
	// those shards in the now-empty active `tasks/` dir, permanently split from the record they
	// belong to and outside anywhere `readTaskLog` looks for an archived task.
	const logFrom = taskLogPath(dotDir, normalized);
	const movedLogs: Array<[string, string]> = [];
	let wroteArchive = false;
	try {
		for (const suffix of LOG_SUFFIXES) {
			const from = `${logFrom}${suffix}`;
			if (!existsSync(from)) continue;
			const to = `${archiveLog}${suffix}`;
			await rename(from, to);
			movedLogs.push([from, to]);
		}
		await writeStoredTask({ ...document, path: archiveMd });
		wroteArchive = true;
		await rm(taskPath(dotDir, normalized), { force: true });
	} catch (error) {
		const undoFailures: string[] = [];
		if (wroteArchive || existsSync(archiveMd)) {
			await rm(archiveMd, { force: true }).catch((e) => undoFailures.push(errorMessage(e)));
		}
		const stranded: string[] = [];
		for (const [from, to] of movedLogs.reverse()) {
			await rename(to, from).catch((e) => {
				undoFailures.push(errorMessage(e));
				stranded.push(`${to} -> ${from}`);
			});
		}
		if (undoFailures.length > 0) throw new ArchiveUndoError(error, stranded, undoFailures);
		throw error;
	}
}
