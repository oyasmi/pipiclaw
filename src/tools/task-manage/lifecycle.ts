import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../../shared/atomic-file.js";
import { formatLocalTime } from "../../shared/local-time.js";
import { workspaceSubjectHash } from "../../tasks/artifact-subject.js";
import {
	appendCurrentCycleNote,
	applyTaskPlanPatch,
	normalizeTaskId,
	readActiveTasks,
	uncheckedTaskAcceptanceItems,
} from "../../tasks/ledger.js";
import { taskBodyHash } from "../../tasks/store.js";
import { normalizeStoredStatus, resolveTaskTransition } from "../../tasks/transitions.js";
import { RecoverableToolError } from "../tool-details.js";
import {
	appendCompletionEvidence,
	applySet,
	cleanupTaskEvents,
	describeTaskSchedule,
	markdownValue,
	readTaskDocument,
	renderTaskFile,
	requiredField,
	tasksDir,
} from "./shared.js";
import type { TaskFields, TaskManageRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";
import { assertVerificationAttestationMatches } from "./verification.js";

export async function setTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "set" requires an id.');
	const id = normalizeTaskId(request.id);
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id, request.control !== undefined);
	const fromStatus = normalizeStoredStatus(fields.status);
	resolveTaskTransition("set", id, fromStatus, request.status);
	const nextFields = applySet(fields, request);
	if (nextFields.status === "sleeping" && !nextFields.schedule) {
		throw new RecoverableToolError(`Task "${id}" is one-shot; sleeping is valid only for recurring tasks.`);
	}
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, body));
	return {
		action: "set",
		id,
		path: taskPath,
		status: nextFields.status,
		notice: `已更新任务 \`${id}\`（${describeTaskSchedule(nextFields)}）。`,
	};
}

export async function progressTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "progress" requires an id.');
	const id = normalizeTaskId(request.id);
	const note = requiredField(request.note, "note", "progress");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	const from = normalizeStoredStatus(fields.status);
	resolveTaskTransition("progress", id, from, request.status);
	if (from === "sleeping") {
		throw new RecoverableToolError(`Task "${id}" is sleeping; wait for its occurrence or use /tasks run ${id}.`);
	}
	const nextFields = applySet(fields, request);
	if (nextFields.status === "sleeping") {
		throw new RecoverableToolError(
			`Progress cannot open a recurring cycle; use /tasks run ${id} or wait for its wake.`,
		);
	}
	if (nextFields.control) {
		if (nextFields.status === "active") {
			nextFields.control.waitingFor = undefined;
		} else if (!nextFields.control.waitingFor) {
			nextFields.control.waitingFor = nextFields.wake ? "time" : "external-signal";
		}
	}
	const { body: bodyWithPlan, summary: planSummary } = request.planSteps?.length
		? applyTaskPlanPatch(body, request.planSteps)
		: { body, summary: "" };
	const nextBody = appendCurrentCycleNote(bodyWithPlan, planSummary ? `${note} ${planSummary}` : note);
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, nextBody));
	return {
		action: "progress",
		id,
		path: taskPath,
		status: nextFields.status,
		notice: `已记录任务 \`${id}\` 的进展（${describeTaskSchedule(nextFields)}）。`,
	};
}

export async function completeTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "complete" requires an id.');
	const id = normalizeTaskId(request.id);
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("complete", id, normalizeStoredStatus(fields.status));
	const uncheckedAcceptance = uncheckedTaskAcceptanceItems(body);
	if (uncheckedAcceptance.length > 0) {
		throw new RecoverableToolError(
			`Task "${id}" still has unchecked acceptance items: ${uncheckedAcceptance.join("; ")}. Check them with evidence before complete.`,
		);
	}
	if (fields.control?.verification.required) {
		const verification = fields.control.verification;
		if (verification.status !== "passed" || !verification.runId) {
			throw new RecoverableToolError(
				`Task "${id}" requires an independent PASS. Dispatch a purpose=verify sub-agent, then task_manage verify with its run id.`,
			);
		}
		// The attestation file is the sole authority — for the verdict, the body-hash freshness
		// check, and the artifact subject. The task Markdown is agent-writable and proves nothing.
		const attestation = await assertVerificationAttestationMatches(
			options.channelDir,
			id,
			verification.runId,
			taskBodyHash(body),
		);
		if (attestation.subjectHash) {
			const subjectDir = attestation.subjectDir ?? options.workingDirectory ?? process.cwd();
			const currentSubject = await workspaceSubjectHash(subjectDir);
			if (!currentSubject) {
				throw new RecoverableToolError(
					`Task "${id}" has an independent PASS bound to ${subjectDir}, but that checkout cannot be read. Restore it or request verification again.`,
				);
			}
			if (currentSubject !== attestation.subjectHash) {
				throw new RecoverableToolError(
					`Task "${id}" artifacts changed after its independent PASS; request verification again.`,
				);
			}
		}
	}

	const bodyWithEvidence = appendCompletionEvidence(body, request);
	if (fields.control) {
		fields.control.waitingFor = undefined;
	}
	const recurring = Boolean(fields.schedule);
	const closedAt = formatLocalTime();
	let finalPath = taskPath;
	let archived = false;
	if (recurring) {
		const sleepingFields: TaskFields = {
			...fields,
			status: "sleeping",
			enabled: true,
			wake: undefined,
		};
		await writeFileAtomically(taskPath, renderTaskFile(sleepingFields, bodyWithEvidence));
	} else {
		const archiveDir = join(dir, "archive");
		await mkdir(archiveDir, { recursive: true });
		const archiveFields: TaskFields = {
			...fields,
			outcome: "completed",
			closedAt,
			enabled: undefined,
		};
		await writeFileAtomically(taskPath, renderTaskFile(archiveFields, bodyWithEvidence));
		finalPath = join(archiveDir, `${id}.md`);
		await rename(taskPath, finalPath);
		archived = true;
	}
	const { deleted } = await cleanupTaskEvents(options, id);
	const cleanup = deleted.length > 0 ? `，清理事件 ${deleted.join(", ")}` : "";
	return {
		action: "complete",
		id,
		path: finalPath,
		status: recurring ? "sleeping" : undefined,
		archived,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已完成（${archived ? "已归档" : "已进入 sleeping，等待下一 occurrence"}${cleanup}）。`,
	};
}

export async function skipTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "skip" requires an id.');
	const id = normalizeTaskId(request.id);
	const reason = requiredField(request.reason, "reason", "skip");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("skip", id, normalizeStoredStatus(fields.status));
	if (!fields.schedule) {
		throw new RecoverableToolError(
			`Task "${id}" is not recurring; use complete after satisfying its DoD or cancel it.`,
		);
	}
	const skippedBody = appendCurrentCycleNote(body, `Skipped: ${reason}`);
	if (fields.control) {
		fields.control.waitingFor = undefined;
		fields.control.verification = { required: fields.control.verification.required, status: "pending" };
	}
	await writeFileAtomically(
		taskPath,
		renderTaskFile({ ...fields, status: "sleeping", enabled: true, wake: undefined }, skippedBody),
	);
	const { deleted } = await cleanupTaskEvents(options, id);
	return {
		action: "skip",
		id,
		path: taskPath,
		status: "sleeping",
		archived: false,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 本周期已跳过并进入 sleeping，等待下一次计划唤醒；若无需通知用户，请回复 [SILENT]。`,
	};
}

export async function cancelTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "cancel" requires an id.');
	const id = normalizeTaskId(request.id);
	const reason = requiredField(request.reason, "reason", "cancel");
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("cancel", id, normalizeStoredStatus(fields.status));
	const cancelledBody = `${body.replace(/\n+$/, "\n")}\n## Cancellation\n\n- Reason: ${markdownValue(reason)}\n`;
	const archiveDir = join(dir, "archive");
	await mkdir(archiveDir, { recursive: true });
	await writeFileAtomically(
		taskPath,
		renderTaskFile(
			{ ...fields, outcome: "cancelled", closedAt: formatLocalTime(), enabled: undefined },
			cancelledBody,
		),
	);
	const { deleted } = await cleanupTaskEvents(options, id);
	const finalPath = join(archiveDir, `${id}.md`);
	await rename(taskPath, finalPath);
	return {
		action: "cancel",
		id,
		path: finalPath,
		status: undefined,
		archived: true,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已取消并归档${deleted.length ? `，清理事件 ${deleted.join(", ")}` : ""}。`,
	};
}

export async function listTasks(options: TaskManageToolOptions): Promise<TaskManageResult> {
	const entries = (await readActiveTasks(tasksDir(options))).filter((entry) => !entry.frontmatter.archiveOutcome);
	return {
		action: "list",
		tasks: entries.map((entry) => ({
			id: entry.id,
			title: entry.title,
			status: entry.frontmatter.readable ? (entry.frontmatter.status ?? "active") : "unreadable",
			enabled: entry.frontmatter.enabled,
			wake: entry.frontmatter.wake,
			actionable: entry.actionable,
			control: entry.frontmatter.control,
		})),
		notice: `台账共有 ${entries.length} 个 active 目录任务。`,
	};
}
