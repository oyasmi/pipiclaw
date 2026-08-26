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
import type {
	TaskCloseRequest,
	TaskFields,
	TaskManageResult,
	TaskManageToolOptions,
	TaskUpdateRequest,
} from "./types.js";
import { assertVerificationAttestationMatches } from "./verification.js";

/**
 * `task_update` merges the old `progress`/`set` actions into one, branching on whether `note` is
 * present (spec 046, D3.2): a note means "checkpoint an open cycle" (active/waiting only, and
 * never repairs a bad control line in the same call); no note means "metadata-only edit" (also
 * allowed on sleeping, and the only path that can repair an unparsable control line).
 */
export async function updateTask(
	options: TaskManageToolOptions,
	request: TaskUpdateRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const hasNote = request.note !== undefined;
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id, !hasNote && request.control !== undefined);
	const from = normalizeStoredStatus(fields.status);
	resolveTaskTransition(hasNote ? "checkpoint" : "metadata", id, from, request.status);
	const nextFields = applySet(fields, request);
	if (nextFields.status === "sleeping" && !nextFields.schedule) {
		throw new RecoverableToolError(`Task "${id}" is one-shot; sleeping is valid only for recurring tasks.`);
	}
	if (hasNote && nextFields.status === "sleeping") {
		throw new RecoverableToolError(
			`Progress cannot open a recurring cycle; use /tasks run ${id} or wait for its wake.`,
		);
	}
	if (hasNote && nextFields.control) {
		if (nextFields.status === "active") {
			nextFields.control.waitingFor = undefined;
		} else if (!nextFields.control.waitingFor) {
			nextFields.control.waitingFor = nextFields.wake ? "time" : "external-signal";
		}
	}
	let nextBody = body;
	if (request.planSteps?.length) {
		const patched = applyTaskPlanPatch(body, request.planSteps);
		nextBody = hasNote
			? appendCurrentCycleNote(patched.body, patched.summary ? `${request.note} ${patched.summary}` : request.note!)
			: patched.body;
	} else if (hasNote) {
		nextBody = appendCurrentCycleNote(body, request.note!);
	}
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, nextBody));
	return {
		action: "update",
		id,
		path: taskPath,
		status: nextFields.status,
		notice: hasNote
			? `已记录任务 \`${id}\` 的进展（${describeTaskSchedule(nextFields)}）。`
			: `已更新任务 \`${id}\`（${describeTaskSchedule(nextFields)}）。`,
	};
}

async function closeAsComplete(
	options: TaskManageToolOptions,
	id: string,
	request: TaskCloseRequest,
): Promise<TaskManageResult> {
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("complete", id, normalizeStoredStatus(fields.status));
	const uncheckedAcceptance = uncheckedTaskAcceptanceItems(body);
	if (uncheckedAcceptance.length > 0) {
		throw new RecoverableToolError(
			`Task "${id}" still has unchecked acceptance items: ${uncheckedAcceptance.join("; ")}. Check them with evidence before task_close.`,
		);
	}
	let verificationNote = "";
	if (fields.control?.verification.required) {
		const verification = fields.control.verification;
		if (verification.status !== "passed" || !verification.runId) {
			throw new RecoverableToolError(
				`Task "${id}" requires an independent PASS. Dispatch a purpose=verify sub-agent, then task_verify with its run id.`,
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
		// advisory means runtime could not structurally prove the verifier left artifacts alone
		// (external harness, or bash left in an internal verifier's tool set) — surface it at the
		// one moment completion is actually decided, not just in a file nobody re-reads (review
		// 2026-08-23 §2.1).
		if (attestation.verificationStrength === "advisory") {
			verificationNote = " ⚠️ 验收结论为 advisory：runtime 无法证明验收者未改动产物，请自行抽查 diff 与测试结果。";
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
		action: "close",
		id,
		path: finalPath,
		status: recurring ? "sleeping" : undefined,
		archived,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已完成（${archived ? "已归档" : "已进入 sleeping，等待下一 occurrence"}${cleanup}）。${verificationNote}`,
	};
}

async function closeAsSkip(
	options: TaskManageToolOptions,
	id: string,
	request: TaskCloseRequest,
): Promise<TaskManageResult> {
	const reason = requiredField(request.reason, "reason", "task_close outcome=skip");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("skip", id, normalizeStoredStatus(fields.status));
	if (!fields.schedule) {
		throw new RecoverableToolError(
			`Task "${id}" is not recurring; use task_close outcome=complete after satisfying its DoD, or outcome=cancel.`,
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
		action: "close",
		id,
		path: taskPath,
		status: "sleeping",
		archived: false,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 本周期已跳过并进入 sleeping，等待下一次计划唤醒；若无需通知用户，请回复 [SILENT]。`,
	};
}

async function closeAsCancel(
	options: TaskManageToolOptions,
	id: string,
	request: TaskCloseRequest,
): Promise<TaskManageResult> {
	const reason = requiredField(request.reason, "reason", "task_close outcome=cancel");
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
		action: "close",
		id,
		path: finalPath,
		status: undefined,
		archived: true,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已取消并归档${deleted.length ? `，清理事件 ${deleted.join(", ")}` : ""}。`,
	};
}

export async function closeTask(options: TaskManageToolOptions, request: TaskCloseRequest): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	switch (request.outcome) {
		case "complete":
			return closeAsComplete(options, id, request);
		case "skip":
			return closeAsSkip(options, id, request);
		case "cancel":
			return closeAsCancel(options, id, request);
	}
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
