import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime, parseLocalTime } from "../shared/local-time.js";
import { createDefaultTaskControl, resetTaskControlForCycle, type TaskWaitingFor } from "./control.js";
import {
	normalizeTaskId,
	parseTaskFrontmatter,
	renderTaskDocument,
	startTaskCycle,
	type TaskDocumentFields,
	taskBody,
	taskContractSegment,
} from "./ledger.js";
import { withTaskMutation } from "./mutation-lock.js";
import { normalizeStoredStatus, resolveTaskTransition } from "./transitions.js";

export interface StoredTaskDocument {
	id: string;
	path: string;
	fields: TaskDocumentFields;
	body: string;
}

/**
 * Hash the task's *contract* segment (Goal/DoD/Manual/Verification), not the whole body, so
 * verification PASS survives routine Current Cycle / History logging and only breaks when the
 * contract itself changes (spec 029, D4). Old attestations that hashed the
 * whole body naturally fail this check after upgrade and are re-verified — verification should
 * always reflect current content, so there is no compatibility burden.
 */
export function taskBodyHash(body: string): string {
	return createHash("sha256").update(taskContractSegment(body)).digest("hex");
}

export async function readStoredTask(
	channelDir: string,
	idInput: string,
	includeArchive = false,
	allowInvalidControl = false,
): Promise<StoredTaskDocument | undefined> {
	const id = normalizeTaskId(idInput);
	const activePath = join(channelDir, "tasks", `${id}.md`);
	const archivePath = join(channelDir, "tasks", "archive", `${id}.md`);
	const path = existsSync(activePath)
		? activePath
		: includeArchive && existsSync(archivePath)
			? archivePath
			: undefined;
	if (!path) return undefined;
	const content = await readFile(path, "utf-8");
	const frontmatter = parseTaskFrontmatter(content);
	if (!frontmatter.readable) throw new Error(`Task "${id}" has unreadable frontmatter.`);
	if (frontmatter.controlReadable === false && !allowInvalidControl) {
		throw new Error(`Task "${id}" has unreadable control metadata.`);
	}
	return {
		id,
		path,
		fields: {
			status: frontmatter.status ?? "active",
			legacyStatus: frontmatter.rawStatus,
			enabled: frontmatter.enabled,
			wake: frontmatter.wake,
			schedule: frontmatter.schedule,
			control: frontmatter.control,
			outcome: frontmatter.archiveOutcome,
			closedAt: frontmatter.closedAt,
		},
		body: taskBody(content),
	};
}

export async function writeStoredTask(document: StoredTaskDocument): Promise<void> {
	await writeFileAtomically(document.path, renderTaskDocument(document.fields, document.body));
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
 * A governor stop: disable the task without changing its lifecycle stage or wake. The structured
 * stop record is the durable recovery receipt; notification is handled by the runtime driver.
 */
export async function escalateTask(channelDir: string, id: string, reason: string): Promise<boolean> {
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		resolveTaskTransition("governor-stop", id, status);
		task.fields.enabled = false;
		task.fields.control ??= createDefaultTaskControl();
		task.fields.control.stop = { by: "governor", reason, at: formatLocalTime() };
	});
	return document !== undefined;
}

export interface WakeTaskTransitionHooks {
	/** Test-only fault seam, called immediately before the atomic activation write. */
	beforeActivation?: () => void;
}

/**
 * Atomically convert a due/completion-woken task to active. Idempotent by construction: once a
 * task is no longer `waiting`, a redelivered wake or retry finds `status !== "waiting"` and is a
 * safe no-op, so no separate claim/handoff bookkeeping is needed to detect a duplicate activation.
 */
export async function activateWaitingTask(
	channelDir: string,
	id: string,
	expectedWaitingFor?: TaskWaitingFor,
	hooks?: WakeTaskTransitionHooks,
): Promise<StoredTaskDocument | undefined> {
	let activated = false;
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		if (status !== "waiting" || task.fields.enabled === false) return;
		if (expectedWaitingFor && task.fields.control?.waitingFor !== expectedWaitingFor) return;
		hooks?.beforeActivation?.();
		activated = true;
		task.fields.control ??= createDefaultTaskControl();
		task.fields.status = "active";
		task.fields.wake = undefined;
		if (task.fields.control) task.fields.control.waitingFor = undefined;
	});
	return activated ? document : undefined;
}

/** Return a task to waiting after a transport failed to accept its just-activated turn. */
export async function rollbackWaitingTask(channelDir: string, id: string, waitingFor: TaskWaitingFor): Promise<void> {
	await updateStoredTask(channelDir, id, (task) => {
		if (task.fields.status !== "active") return;
		task.fields.status = "waiting";
		task.fields.wake = undefined;
		if (task.fields.control) task.fields.control.waitingFor = waitingFor;
	});
}

/**
 * A stable cycle id for a runtime-opened recurring cycle: `cycle-YYYY-MM-DD`, disambiguated
 * with a `-N` suffix when the same task is reopened more than once on the same local day.
 */
export function nextCycleId(previousCycleId: string | undefined, occurrence: Date): string {
	const base = `cycle-${occurrence.getFullYear()}-${String(occurrence.getMonth() + 1).padStart(2, "0")}-${String(occurrence.getDate()).padStart(2, "0")}`;
	if (!previousCycleId || !previousCycleId.startsWith(base)) return base;
	const suffix = previousCycleId.slice(base.length + 1);
	const previousCount = suffix ? Number.parseInt(suffix, 10) : 1;
	const nextCount = Number.isFinite(previousCount) && previousCount >= 1 ? previousCount + 1 : 2;
	return `${base}-${nextCount}`;
}

/**
 * Open the next cycle of a sleeping recurring task entirely in the runtime (spec 029, D2):
 * fold the previous cycle's log into History, reset per-cycle control, clear the wake, and
 * mark it `active`. This is the deterministic replacement for the retired
 * no LLM turn is spent just to reopen a cycle.
 */
export async function openRecurringTaskCycle(
	channelDir: string,
	id: string,
	now: Date,
	force = false,
): Promise<{ document: StoredTaskDocument; cycleId: string } | undefined> {
	let cycleId: string | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		const status = normalizeStoredStatus(task.fields.status, Boolean(task.fields.schedule));
		if (status !== "sleeping" || !task.fields.schedule) return;
		const wakeMs = task.fields.wake ? parseLocalTime(task.fields.wake) : undefined;
		if (!force && (task.fields.enabled === false || wakeMs === undefined || wakeMs > now.getTime())) return;
		const occurrence = !force && wakeMs !== undefined ? new Date(wakeMs) : now;
		cycleId = nextCycleId(task.fields.control?.cycleId, occurrence);
		task.fields.control ??= createDefaultTaskControl();
		const firstCycle = !task.fields.control.cycleId;
		task.body = startTaskCycle(task.body, cycleId, !firstCycle);
		task.fields.status = "active";
		task.fields.enabled = true;
		task.fields.wake = undefined;
		task.fields.control = resetTaskControlForCycle(task.fields.control, cycleId);
	});
	if (!document || !cycleId) return undefined;
	return { document, cycleId };
}
