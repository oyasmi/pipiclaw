import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { createCycle, nextCycleId, openCycleBody } from "./cycle.js";
import {
	normalizeTaskFrontmatter,
	parseTaskFrontmatterV4,
	type TaskArchiveOutcome,
	type TaskFrontmatterV4,
	type TaskPaused,
} from "./frontmatter.js";
import { normalizeTaskId, renderTaskDocument, taskBody } from "./ledger.js";
import { appendTaskLog, taskLogPath } from "./log.js";
import { withTaskMutation } from "./mutation-lock.js";
import { describeTicket, type Ticket } from "./ticket.js";

export interface StoredTaskDocument {
	id: string;
	path: string;
	fields: TaskFrontmatterV4;
	body: string;
}

/**
 * The contract's hard size budget (INV-6).
 *
 * v3 task files on the author's machine sat permanently at 30 KB, 79% of it closed-cycle
 * history, and every wake read all of it. The contract is injected whole into every step brief,
 * so it has to stay small by construction rather than by discipline: the only unbounded section
 * left (`## 上次结果`) is clipped at write time, and anything beyond this cap is truncated with a
 * pointer to `task_log`.
 */
export const MAX_CONTRACT_BYTES = 4 * 1024;
const CONTRACT_TRUNCATION_NOTE = "\n\n<!-- 契约超出 4 KB 预算，尾部已截断；完整记录见 task_log。 -->\n";

export function tasksDir(channelDir: string): string {
	return join(channelDir, "tasks");
}

export function taskPath(channelDir: string, id: string): string {
	return join(tasksDir(channelDir), `${normalizeTaskId(id)}.md`);
}

export function archivedTaskPath(channelDir: string, id: string): string {
	return join(tasksDir(channelDir), "archive", `${normalizeTaskId(id)}.md`);
}

export async function readStoredTask(
	channelDir: string,
	idInput: string,
	includeArchive = false,
): Promise<StoredTaskDocument | undefined> {
	const id = normalizeTaskId(idInput);
	const activePath = taskPath(channelDir, id);
	const archivePath = archivedTaskPath(channelDir, id);
	const path = existsSync(activePath)
		? activePath
		: includeArchive && existsSync(archivePath)
			? archivePath
			: undefined;
	if (!path) return undefined;
	const content = await readFile(path, "utf-8");
	const parsed = parseTaskFrontmatterV4(content);
	return { id, path, fields: parsed.fields, body: taskBody(content) };
}

/** Clip a body that would push the contract over budget, keeping the head (the contract proper). */
function enforceContractBudget(fields: TaskFrontmatterV4, body: string): string {
	const rendered = renderTaskDocument(fields, body);
	if (Buffer.byteLength(rendered, "utf-8") <= MAX_CONTRACT_BYTES) return body;
	const overhead = Buffer.byteLength(rendered, "utf-8") - Buffer.byteLength(body, "utf-8");
	const allowance = Math.max(0, MAX_CONTRACT_BYTES - overhead - Buffer.byteLength(CONTRACT_TRUNCATION_NOTE, "utf-8"));
	const buffer = Buffer.from(body, "utf-8");
	if (buffer.byteLength <= allowance) return body;
	// Cut on a character boundary: `toString` on a sliced buffer would otherwise be able to split
	// a multi-byte codepoint and write a replacement character into a hand-editable file.
	let clipped = new TextDecoder("utf-8", { fatal: false }).decode(buffer.subarray(0, allowance));
	clipped = clipped.replace(/�+$/, "");
	const lastNewline = clipped.lastIndexOf("\n");
	if (lastNewline > 0) clipped = clipped.slice(0, lastNewline);
	return `${clipped.trimEnd()}${CONTRACT_TRUNCATION_NOTE}`;
}

export async function writeStoredTask(document: StoredTaskDocument): Promise<void> {
	const fields = normalizeTaskFrontmatter(document.fields);
	const body = enforceContractBudget(fields, document.body);
	await writeFileAtomically(document.path, renderTaskDocument(fields, body));
}

export async function updateStoredTask(
	channelDir: string,
	id: string,
	update: (document: StoredTaskDocument) => void,
	includeArchive = false,
): Promise<StoredTaskDocument | undefined> {
	return withTaskMutation(channelDir, id, async () => {
		const document = await readStoredTask(channelDir, id, includeArchive);
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
export async function parkTask(
	channelDir: string,
	id: string,
	ticket: Ticket,
): Promise<StoredTaskDocument | undefined> {
	return updateStoredTask(channelDir, id, (task) => {
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
	channelDir: string,
	id: string,
	matches: (ticket: Ticket) => boolean,
): Promise<{ document: StoredTaskDocument; ticket: Ticket } | undefined> {
	let redeemed: Ticket | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		if (task.fields.state !== "parked" || !task.fields.ticket || task.fields.paused) return;
		if (!matches(task.fields.ticket)) return;
		redeemed = task.fields.ticket;
		task.fields.state = "open";
		task.fields.ticket = undefined;
	});
	return document && redeemed ? { document, ticket: redeemed } : undefined;
}

/** Disable a task without losing its stage. `paused` present *is* the disabled state (D1). */
export async function pauseTask(
	channelDir: string,
	id: string,
	paused: Omit<TaskPaused, "at"> & { at?: string },
): Promise<StoredTaskDocument | undefined> {
	return updateStoredTask(channelDir, id, (task) => {
		task.fields.paused = { ...paused, at: paused.at ?? formatLocalTime() };
	});
}

export async function resumeTask(channelDir: string, id: string): Promise<StoredTaskDocument | undefined> {
	return updateStoredTask(channelDir, id, (task) => {
		task.fields.paused = undefined;
	});
}

/**
 * The backstop transition (D2): a parked task whose `by` has passed goes back to `open` so its
 * next step can re-check reality, and the second expiry in the same cycle stops the task and
 * hands the user a deterministic receipt instead of burning another wake.
 *
 * Returns what the caller should do about it, or `undefined` when nothing applied.
 */
export type TicketExpiryOutcome = "reopened" | "paused";

export async function expireTicket(
	channelDir: string,
	id: string,
	limit = 2,
): Promise<{ document: StoredTaskDocument; outcome: TicketExpiryOutcome; ticket: string } | undefined> {
	let outcome: TicketExpiryOutcome | undefined;
	let summary = "";
	const document = await updateStoredTask(channelDir, id, (task) => {
		const ticket = task.fields.ticket;
		if (task.fields.state !== "parked" || !ticket || task.fields.paused) return;
		summary = describeTicket(ticket);
		const expired = (task.fields.cycle?.expired ?? 0) + 1;
		if (task.fields.cycle) task.fields.cycle = { ...task.fields.cycle, expired };
		if (expired >= limit) {
			outcome = "paused";
			task.fields.paused = {
				by: "runtime",
				reason: `等待票连续 ${expired} 次未兑现：${summary}`,
				at: formatLocalTime(),
			};
			return;
		}
		outcome = "reopened";
		task.fields.state = "open";
		task.fields.ticket = undefined;
	});
	if (!document || !outcome) return undefined;
	await appendTaskLog(channelDir, id, {
		cycle: document.fields.cycle?.id ?? "-",
		kind: "expired",
		ticket: summary,
		action: outcome,
	});
	return { document, outcome, ticket: summary };
}

/**
 * Open the next cycle: fresh counters, a fresh cycle id, and (for a recurring task) a Plan and
 * acceptance checklist reset. Deterministic and zero-token — no LLM turn is spent just to start
 * a cycle, which is why a missed occurrence can self-heal without waking anything.
 */
export async function openCycle(
	channelDir: string,
	id: string,
	now: Date = new Date(),
): Promise<{ document: StoredTaskDocument; cycleId: string } | undefined> {
	let cycleId: string | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		if (task.fields.paused || task.fields.outcome) return;
		cycleId = nextCycleId(task.fields.cycle?.id, now);
		const recurring = Boolean(task.fields.schedule) && Boolean(task.fields.cycle);
		task.body = openCycleBody(task.body, recurring);
		task.fields.cycle = createCycle(cycleId, now);
		task.fields.state = "open";
		task.fields.ticket = undefined;
	});
	if (!document || !cycleId) return undefined;
	return { document, cycleId };
}

/** Move a closed task (and its log) into `tasks/archive/`. */
export async function archiveTask(channelDir: string, id: string, outcome: TaskArchiveOutcome): Promise<void> {
	const normalized = normalizeTaskId(id);
	const archiveDir = join(tasksDir(channelDir), "archive");
	await mkdir(archiveDir, { recursive: true });
	const document = await readStoredTask(channelDir, normalized);
	if (!document) return;
	document.fields.outcome = outcome;
	document.fields.closedAt = formatLocalTime();
	await writeStoredTask({ ...document, path: archivedTaskPath(channelDir, normalized) });
	await rm(taskPath(channelDir, normalized), { force: true });
	// The loop log travels with its contract so an archived task stays inspectable.
	const logFrom = taskLogPath(channelDir, normalized);
	if (existsSync(logFrom)) {
		await rename(logFrom, join(archiveDir, `${normalized}.jsonl`)).catch(() => undefined);
	}
}
