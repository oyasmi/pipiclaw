import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import {
	normalizeTaskId,
	parseTaskFrontmatter,
	renderTaskDocument,
	startTaskCycle,
	type TaskDocumentFields,
	taskBody,
} from "../shared/task-ledger.js";
import { resetTaskControlForCycle, type TaskControl, type TaskOutcome } from "./control.js";

export interface StoredTaskDocument {
	id: string;
	path: string;
	fields: TaskDocumentFields;
	body: string;
}

export function taskBodyHash(body: string): string {
	return createHash("sha256").update(body).digest("hex");
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
			wake: frontmatter.wake,
			schedule: frontmatter.schedule,
			recurrence: frontmatter.recurrence,
			control: frontmatter.control,
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
	const document = await readStoredTask(channelDir, id, includeArchive);
	if (!document) return undefined;
	update(document);
	await writeStoredTask(document);
	return document;
}

export interface TaskAttemptClaim {
	control: TaskControl;
	previousLastOutcome: TaskOutcome;
	previousBlockedReason?: string;
	previousLastStartedAt?: string;
}

export async function claimTaskAttempt(
	channelDir: string,
	id: string,
	now: Date,
): Promise<TaskAttemptClaim | undefined> {
	let claim: TaskAttemptClaim | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		if (!task.fields.control) return;
		claim = {
			control: task.fields.control,
			previousLastOutcome: task.fields.control.lastOutcome,
			previousBlockedReason: task.fields.control.blockedReason,
			previousLastStartedAt: task.fields.control.lastStartedAt,
		};
		task.fields.control.usage.attempts++;
		task.fields.control.lastStartedAt = now.toISOString();
		task.fields.control.lastOutcome = "running";
	});
	if (claim && document?.fields.control) claim.control = document.fields.control;
	return claim;
}

export async function releaseTaskAttemptClaim(
	channelDir: string,
	id: string,
	claim: TaskAttemptClaim,
	startedAt: Date,
): Promise<void> {
	await updateStoredTask(channelDir, id, (task) => {
		const control = task.fields.control;
		if (!control || control.lastStartedAt !== startedAt.toISOString()) return;
		control.usage.attempts = Math.max(0, control.usage.attempts - 1);
		control.lastStartedAt = claim.previousLastStartedAt;
		control.lastOutcome = claim.previousLastOutcome;
		control.blockedReason = claim.previousBlockedReason;
	});
}

export async function finishTaskAttempt(
	channelDir: string,
	id: string,
	result: {
		tokens: number;
		costUsd: number;
		wallTimeMinutes: number;
		failed: boolean;
		silent?: boolean;
		finishedAt: Date;
	},
): Promise<void> {
	await updateStoredTask(
		channelDir,
		id,
		(task) => {
			const control = task.fields.control;
			if (!control) return;
			control.usage.tokens += Math.max(0, Math.floor(result.tokens));
			control.usage.costUsd += Math.max(0, result.costUsd);
			control.usage.wallTimeMinutes += Math.max(0, result.wallTimeMinutes);
			control.lastFinishedAt = result.finishedAt.toISOString();
			if (result.silent) {
				// The driver claimed before dispatch to prevent concurrent work. A silent
				// turn performed no task advancement, so retain its cost audit but not its
				// attempt charge.
				control.usage.attempts = Math.max(0, control.usage.attempts - 1);
				if (control.lastOutcome === "running") {
					control.lastOutcome = "pending";
					control.blockedReason = undefined;
				}
			} else if (result.failed) {
				control.lastOutcome = "failed";
				control.blockedReason = "The previous agent run failed; inspect the runtime error before retrying.";
			} else if (control.lastOutcome === "running") {
				control.lastOutcome = "progress";
				control.blockedReason = undefined;
			}
		},
		true,
	);
}

/**
 * A governor stop: the deterministic task governor pauses the task (spec 029, D3 — this is
 * the former `escalated` status, now `paused` + `pausedBy: "governor"`), records the reason,
 * and clears the wake so no automatic dispatch resumes it until a human intervenes.
 */
export async function escalateTask(channelDir: string, id: string, reason: string): Promise<boolean> {
	const document = await updateStoredTask(channelDir, id, (task) => {
		task.fields.status = "paused";
		task.fields.wake = undefined;
		if (task.fields.control) {
			task.fields.control.pausedBy = "governor";
			task.fields.control.lastOutcome = "blocked";
			task.fields.control.blockedReason = reason;
		}
	});
	return document !== undefined;
}

/**
 * A stable cycle id for a runtime-opened recurring cycle: `cycle-YYYY-MM-DD`, disambiguated
 * with a `-N` suffix when the same task is reopened more than once on the same local day.
 */
export function nextCycleId(previousCycleId: string | undefined, now: Date): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	const base = `cycle-${y}-${m}-${d}`;
	if (!previousCycleId || (previousCycleId !== base && !previousCycleId.startsWith(`${base}-`))) return base;
	const suffix = previousCycleId.slice(base.length + 1);
	const previousCount = suffix ? Number.parseInt(suffix, 10) : 1;
	const nextCount = Number.isFinite(previousCount) && previousCount >= 1 ? previousCount + 1 : 2;
	return `${base}-${nextCount}`;
}

/**
 * Open the next cycle of a done recurring task entirely in the runtime (spec 029, D2):
 * fold the previous cycle's log into History, reset per-cycle control, clear the wake, and
 * mark it `active`. This is the deterministic replacement for the retired
 * `task_manage start-cycle` action — no LLM turn is spent just to reopen a cycle.
 */
export async function openRecurringTaskCycle(
	channelDir: string,
	id: string,
	now: Date,
): Promise<{ document: StoredTaskDocument; cycleId: string } | undefined> {
	let cycleId: string | undefined;
	const document = await updateStoredTask(channelDir, id, (task) => {
		cycleId = nextCycleId(task.fields.control?.cycleId, now);
		task.body = startTaskCycle(task.body, cycleId);
		task.fields.status = "active";
		task.fields.wake = undefined;
		if (task.fields.control) task.fields.control = resetTaskControlForCycle(task.fields.control, cycleId);
	});
	if (!document || !cycleId) return undefined;
	return { document, cycleId };
}

export async function dependencyState(
	channelDir: string,
	dependencyIds: readonly string[],
	ownerId?: string,
): Promise<{ ready: boolean; reason?: string }> {
	const detectCycle = async (id: string, path: string[], active: Set<string>): Promise<string | undefined> => {
		if (id === ownerId || active.has(id)) return `dependency cycle detected (${[...path, id].join(" -> ")})`;
		const dependency = await readStoredTask(channelDir, id, true, true);
		if (!dependency || dependency.fields.status === "done") return undefined;
		const nextActive = new Set(active).add(id);
		for (const nestedId of dependency.fields.control?.dependsOn ?? []) {
			const cycle = await detectCycle(nestedId, [...path, id], nextActive);
			if (cycle) return cycle;
		}
		return undefined;
	};
	for (const dependencyId of dependencyIds) {
		const cycle = await detectCycle(dependencyId, ownerId ? [ownerId] : [], new Set());
		if (cycle) return { ready: false, reason: cycle };
	}
	for (const dependencyId of dependencyIds) {
		const dependency = await readStoredTask(channelDir, dependencyId, true, true);
		if (!dependency) return { ready: false, reason: `dependency ${dependencyId} is missing` };
		if (dependency.fields.status === "cancelled") {
			return { ready: false, reason: `dependency ${dependencyId} is cancelled` };
		}
		// A governor-paused dependency will not self-recover, so it blocks the dependent
		// terminally (matches the retired `escalated` semantics); a user pause is a soft wait.
		if (dependency.fields.status === "paused") {
			return dependency.fields.control?.pausedBy === "governor"
				? { ready: false, reason: `dependency ${dependencyId} is paused by the governor` }
				: { ready: false, reason: `waiting for dependency ${dependencyId} (paused)` };
		}
		if (dependency.fields.status !== "done")
			return { ready: false, reason: `waiting for dependency ${dependencyId}` };
	}
	return { ready: true };
}
