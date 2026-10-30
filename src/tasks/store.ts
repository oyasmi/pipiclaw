import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as log from "../log.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { commitTaskArchive, isTaskArchiving } from "./archive.js";
import { createUsage } from "./budget.js";
import { pendingTaskClose, taskReportDelivered } from "./completion.js";
import { assertTaskAcceptance, normalizeTaskId, renderTaskDocument, taskBody } from "./contract.js";
import { queueTaskReceipt } from "./delivery.js";
import {
	normalizeTaskFrontmatter,
	parseTaskFrontmatter,
	type TaskArchiveOutcome,
	type TaskBudget,
	type TaskFrontmatter,
	type TaskPaused,
} from "./frontmatter.js";
import {
	appendTaskLog,
	lastStep,
	newInputs,
	readTaskLog,
	type TaskInputRecord,
	type TaskLogInput,
	type TaskLogRecord,
	type TaskStepReason,
	type TaskStepResult,
} from "./loop-log.js";
import { withTaskMutation } from "./mutation-lock.js";
import { deriveAfterStep, deriveStepReason, reconcileOnBoot, type StepDerivation, type StepFacts } from "./state.js";

export interface StoredTaskDocument {
	id: string;
	path: string;
	fields: TaskFrontmatter;
	body: string;
	/** Snapshot lagged its durable log; the next mutation/reconciliation persists it. */
	recovered?: boolean;
}

/**
 * The contract's size target. The contract is injected whole into every step brief, so a long one
 * costs on every step. The runtime never rewrites the body (INV-6), so there is nothing it could
 * clip: a contract over the target is written as-is and warned about once per write.
 */
export const MAX_CONTRACT_BYTES = 4 * 1024;

export function tasksDir(deskDir: string): string {
	return join(deskDir, "tasks");
}

export function taskPath(deskDir: string, id: string): string {
	return join(tasksDir(deskDir), `${normalizeTaskId(id)}.md`);
}

export function archivedTaskPath(deskDir: string, id: string): string {
	return join(tasksDir(deskDir), "archive", `${normalizeTaskId(id)}.md`);
}

export async function readStoredTask(
	deskDir: string,
	idInput: string,
	includeArchive = false,
): Promise<StoredTaskDocument | undefined> {
	const id = normalizeTaskId(idInput);
	const activePath = taskPath(deskDir, id);
	const archivePath = archivedTaskPath(deskDir, id);
	const path = existsSync(activePath)
		? activePath
		: includeArchive && existsSync(archivePath)
			? archivePath
			: undefined;
	if (!path) return undefined;
	const content = await readFile(path, "utf-8");
	const parsed = parseTaskFrontmatter(content);
	let fields = parsed.fields;
	let recovered = false;
	if (path === activePath) {
		for (const record of await readTaskLog(deskDir, id, { strict: true })) {
			if (record.checkpoint && (record.checkpoint.revision ?? 0) > (fields.revision ?? 0)) {
				fields = normalizeTaskFrontmatter(record.checkpoint);
				recovered = true;
			}
		}
	}
	return { id, path, fields, body: taskBody(content), ...(recovered ? { recovered } : {}) };
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

/** Caller holds the task lock. The log commits first; replay repairs a failed snapshot write. */
export async function commitTask(document: StoredTaskDocument, deskDir: string, record: TaskLogInput): Promise<void> {
	if (isTaskArchiving(deskDir, document.id))
		throw new RecoverableToolError(
			`Task "${document.id}" is committing its archive. Retry after archive recovery completes.`,
		);
	document.fields = normalizeTaskFrontmatter({ ...document.fields, revision: (document.fields.revision ?? 0) + 1 });
	await appendTaskLog(deskDir, document.id, { ...record, checkpoint: document.fields });
	await writeStoredTask(document);
}

export async function updateStoredTask(
	deskDir: string,
	id: string,
	update: (document: StoredTaskDocument) => void,
	includeArchive = false,
): Promise<StoredTaskDocument | undefined> {
	return withTaskMutation(deskDir, id, async () => {
		const document = await readStoredTask(deskDir, id, includeArchive);
		if (!document) return undefined;
		update(document);
		await commitTask(document, deskDir, { kind: "checkpoint" });
		return document;
	});
}

export interface BeginStepInput {
	brief: "full" | "delta";
	/** Recheck the host's reachability/switch policy inside admission's mutation lock. */
	allowed?: (fields: TaskFrontmatter) => boolean;
}

export interface BegunStep {
	document: StoredTaskDocument;
	seq: number;
	reason: TaskStepReason;
	/** The log as it stood before this step's own record. */
	records: TaskLogRecord[];
	/** Unacknowledged inputs read in the same lock hold that admits this step (INV-6). */
	inputs: TaskInputRecord[];
}

/** The states a step may start from. A paused task, or one waiting for the user or a moment, is not the lane's to run. */
function mayBeginStep(fields: TaskFrontmatter): boolean {
	return (
		fields.state === "queued" ||
		fields.state === "running" ||
		(fields.state === "waiting" && fields.waiting?.kind === "work")
	);
}

/**
 * The step began: `running`, no waiting description, and the `step` record — in one lock hold.
 * `undefined` when the task is gone or was paused (or put in a wait the lane does not run from)
 * since the lane decided to run it.
 */
export async function beginStep(deskDir: string, id: string, input: BeginStepInput): Promise<BegunStep | undefined> {
	return withTaskMutation(deskDir, id, async () => {
		const document = await readStoredTask(deskDir, id);
		if (
			!document ||
			document.fields.outcome ||
			!mayBeginStep(document.fields) ||
			input.allowed?.(document.fields) === false
		)
			return undefined;
		if (isTaskArchiving(deskDir, id)) return undefined;
		const records = await readTaskLog(deskDir, id, { strict: true });
		if (pendingTaskClose(records)) return undefined;
		const inputs = newInputs(records);
		const seq = (lastStep(records)?.step.seq ?? 0) + 1;
		const reason = deriveStepReason(records, inputs);
		document.fields.state = "running";
		document.fields.waiting = undefined;
		await commitTask(document, deskDir, { kind: "step", seq, reason, brief: input.brief });
		return { document, seq, reason, records, inputs };
	});
}

export interface EndStepInput {
	seq: number;
	result: TaskStepResult;
	note: string;
	tools: string[];
	usd?: number;
	usdEstimated?: boolean;
	usdKnown?: boolean;
	error?: string;
	facts: StepFacts;
	close?: { outcome: "complete" | "cancel"; note: string; reportId?: string };
}

export interface EndedStep {
	document: StoredTaskDocument;
	derivation: StepDerivation;
}

/**
 * The step ended: its `step_end` record, the usage it spent, and the state D8 derives, written
 * through one replayable checkpoint. A task paused mid-step stays paused;
 * a closed task is left for the caller to archive. `undefined` when the task no longer exists —
 * the user cancelled it while the step ran.
 */
export async function endStep(
	deskDir: string,
	id: string,
	input: EndStepInput,
	now = new Date(),
): Promise<EndedStep | undefined> {
	return withTaskMutation(deskDir, id, async () => {
		const document = await readStoredTask(deskDir, id);
		if (!document || document.fields.outcome) return undefined;
		if (
			(await readTaskLog(deskDir, id, { strict: true })).some(
				(record) => record.kind === "step_end" && record.seq === input.seq,
			)
		)
			return undefined;
		const fields = document.fields;
		const facts: StepFacts = { ...input.facts, pausedByUser: input.facts.pausedByUser || fields.state === "paused" };
		const derivation = deriveAfterStep(facts, now);

		const usage = fields.usage ?? createUsage(now);
		fields.usage = {
			...usage,
			steps: usage.steps + 1,
			usd: usage.usd + Math.max(0, input.usd ?? 0),
			usdEstimated: usage.usdEstimated || input.usdEstimated === true,
			...(input.usdKnown === false ? { unknownCostCount: (usage.unknownCostCount ?? 0) + 1 } : {}),
		};
		if (derivation.next !== "paused") {
			fields.state = derivation.state;
			fields.waiting = derivation.waiting;
		}
		await commitTask(document, deskDir, {
			kind: "step_end",
			...(input.close ? { close: input.close } : {}),
			seq: input.seq,
			result: input.result,
			next: derivation.next,
			note: input.note,
			tools: input.tools,
			...(input.usd && input.usd > 0 ? { usd: input.usd } : {}),
			...(input.usdEstimated ? { usdEstimated: true } : {}),
			...(input.usdKnown === false ? { usdKnown: false } : {}),
			...(input.error ? { error: input.error } : {}),
		});
		return { document, derivation };
	});
}

/**
 * D10 for one task: whatever state a previous process left, make it true to the facts. A step that
 * began but never ended gets its `step_end{interrupted}`; a work wait with nothing in flight goes
 * back in line. Writes state and log only — no model call. Returns whether anything changed.
 */
export async function reconcileTaskState(
	deskDir: string,
	id: string,
	pendingWork: number,
	now = new Date(),
): Promise<boolean> {
	return withTaskMutation(deskDir, id, async () => {
		if (isTaskArchiving(deskDir, id)) return false;
		const document = await readStoredTask(deskDir, id);
		if (!document || document.fields.outcome) return false;
		const records = await readTaskLog(deskDir, id, { strict: true });
		if (pendingTaskClose(records)) return false;
		const reconciled = reconcileOnBoot(document.fields, records, pendingWork, now);
		if (!reconciled) {
			if (document.recovered) await writeStoredTask(document);
			return document.recovered === true;
		}
		document.fields = reconciled.fields;
		if (reconciled.appendStepEnd) {
			await commitTask(document, deskDir, {
				kind: "step_end",
				seq: reconciled.appendStepEnd.seq,
				result: "interrupted",
				next: reconciled.appendStepEnd.next,
				note: "（服务重启时这一步被打断）",
				tools: [],
				usdKnown: false,
			});
		} else await commitTask(document, deskDir, { kind: "checkpoint" });
		return true;
	});
}

/**
 * Put a task back in line (`queued`) — a wake from `waiting{time|user}`, a work wait with nothing
 * left in flight, a repaired start. Idempotent: a task that is not in `waiting` is left alone.
 */
export async function requeueWaiting(deskDir: string, id: string): Promise<StoredTaskDocument | undefined> {
	return updateStoredTask(deskDir, id, (task) => {
		if (task.fields.state !== "waiting") return;
		task.fields.state = "queued";
		task.fields.waiting = undefined;
	});
}

/**
 * Disable a task without losing its stage. The pause and its `pause` record are one write; a task
 * that is already paused, or gone, is a no-op (`undefined`).
 */
export async function pauseTask(
	deskDir: string,
	id: string,
	paused: Omit<TaskPaused, "at"> & { at?: string },
): Promise<StoredTaskDocument | undefined> {
	return withTaskMutation(deskDir, id, async () => {
		const document = await readStoredTask(deskDir, id);
		if (!document || document.fields.outcome || document.fields.state === "paused") return undefined;
		document.fields.state = "paused";
		document.fields.waiting = undefined;
		document.fields.paused = { ...paused, at: paused.at ?? formatLocalTime() };
		await commitTask(document, deskDir, { kind: "pause", by: paused.by, reason: paused.reason });
		return document;
	});
}

/**
 * Lift a pause: back in line, with any budget grant added on top of what the task already spent —
 * so resuming a task that hit its ceiling lets it run rather than re-stopping on the next step.
 * `undefined` when the task is gone or not paused.
 */
export async function resumeTask(
	deskDir: string,
	id: string,
	grants: Partial<TaskBudget> = {},
): Promise<StoredTaskDocument | undefined> {
	return withTaskMutation(deskDir, id, async () => {
		const document = await readStoredTask(deskDir, id);
		if (!document || document.fields.outcome || document.fields.state !== "paused") return undefined;
		const granted: Partial<TaskBudget> = {};
		const budget = { ...document.fields.budget };
		for (const key of ["steps", "usd"] as const) {
			const extra = grants[key];
			if (extra === undefined || extra <= 0) continue;
			const spent = key === "steps" ? document.fields.usage?.steps : document.fields.usage?.usd;
			budget[key] = (spent ?? 0) + extra;
			granted[key] = extra;
		}
		document.fields.state = "queued";
		document.fields.paused = undefined;
		if (Object.keys(granted).length > 0) document.fields.budget = budget;
		await commitTask(document, deskDir, {
			kind: "resume",
			...(Object.keys(granted).length > 0 ? { grants: granted } : {}),
		});
		return document;
	});
}

export interface CloseTaskInput {
	outcome: "complete" | "cancel";
	by: "leader" | "user";
	note: string;
	reportId?: string;
	/** Prepared durably before archiving; the delivery queue sends it only after archive completion. */
	receipt?: (document: StoredTaskDocument, closedAt: string) => string;
}

/**
 * Close a task: the `close` record, then the move into `tasks/archive/`. The checks that decide
 * whether closing is allowed (DoD, work in flight) belong to the caller — they need the run and job
 * managers. `undefined` when the task is already gone.
 */
export async function closeTask(
	deskDir: string,
	id: string,
	input: CloseTaskInput,
): Promise<StoredTaskDocument | undefined> {
	return withTaskMutation(deskDir, id, async () => {
		const document = await readStoredTask(deskDir, id);
		if (isTaskArchiving(deskDir, id)) {
			await archiveTask(deskDir, id, input.outcome === "complete" ? "completed" : "cancelled");
			return document;
		}
		if (!document || document.fields.outcome) return undefined;
		const records = await readTaskLog(deskDir, id, { strict: true });
		if (input.outcome === "complete") {
			assertTaskAcceptance(document.body);
			if (!taskReportDelivered(records, input.reportId, document.fields.channel))
				throw new RecoverableToolError(
					"The final task report is not confirmed delivered. Wait for the runtime's delivery retry before completing this task.",
				);
		}
		const usage = document.fields.usage;
		let prior = [...records].reverse().find((record) => record.kind === "close");
		if (prior && prior.outcome !== (input.outcome === "complete" ? "done" : "cancelled"))
			throw new RecoverableToolError(
				`Task "${id}" already committed a different close outcome. Let archive recovery finish before starting other work.`,
			);
		if (!prior) {
			const ts = formatLocalTime();
			const close = {
				kind: "close",
				outcome: input.outcome === "complete" ? "done" : "cancelled",
				by: input.by,
				note: input.note,
				steps: usage?.steps ?? 0,
				usd: usage?.usd ?? 0,
				...(usage?.usdEstimated ? { usdEstimated: true } : {}),
				...(usage?.unknownCostCount ? { unknownCostCount: usage.unknownCostCount } : {}),
				...(input.reportId ? { reportId: input.reportId } : {}),
				ts,
			} as const;
			const recordId = await appendTaskLog(deskDir, id, close);
			prior = { ...close, id: recordId };
		}
		if (input.receipt && document.fields.channel && prior.id) {
			await queueTaskReceipt(deskDir, id, prior.id, document.fields.channel, input.receipt(document, prior.ts));
		}
		await archiveTask(deskDir, id, input.outcome === "complete" ? "completed" : "cancelled");
		document.fields = {
			...document.fields,
			outcome: input.outcome === "complete" ? "completed" : "cancelled",
			closedAt: prior.ts,
		};
		return document;
	});
}

/** The active handle and all log shards are removed only after a durable archive commit. */
export function archiveTask(deskDir: string, idInput: string, outcome: TaskArchiveOutcome): Promise<void> {
	const id = normalizeTaskId(idInput);
	return withTaskMutation(deskDir, id, async () => {
		if (isTaskArchiving(deskDir, id)) return commitTaskArchive(deskDir, id);
		const document = await readStoredTask(deskDir, id);
		if (!document) return;
		const close = [...(await readTaskLog(deskDir, id, { strict: true }))]
			.reverse()
			.find((record) => record.kind === "close");
		await commitTaskArchive(deskDir, id, document, outcome, close?.ts ?? formatLocalTime());
	});
}
