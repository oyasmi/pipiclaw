import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../../shared/atomic-file.js";
import {
	appendCurrentCycleNote,
	normalizeTaskId,
	readActiveTasks,
	uncheckedTaskAcceptanceItems,
} from "../../shared/task-ledger.js";
import { workspaceSubjectHash } from "../../tasks/artifact-subject.js";
import { invalidateTaskVerification } from "../../tasks/control.js";
import { taskBodyHash } from "../../tasks/store.js";
import { normalizeStoredStatus, resolveTaskTransition } from "../../tasks/transitions.js";
import { RecoverableToolError } from "../tool-details.js";
import {
	appendCompletionEvidence,
	applySet,
	cleanupTaskEvents,
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
	// Leaving the verification lane by hand invalidates any recorded verdict — a passed/failed
	// attestation only describes the task while it stayed in `verifying` (D3).
	if (fromStatus === "verifying" && nextFields.status !== "verifying" && nextFields.control) {
		nextFields.control = invalidateTaskVerification(nextFields.control);
	}
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, body));
	return {
		action: "set",
		id,
		path: taskPath,
		status: nextFields.status,
		notice: `已更新任务 \`${id}\`（status: ${nextFields.status}${nextFields.wake ? `, wake: ${nextFields.wake}` : ""}）。`,
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
	resolveTaskTransition("progress", id, normalizeStoredStatus(fields.status), request.status);
	const nextFields = applySet(fields, request);
	// D4: a progress note only appends to Current Cycle — it never touches the contract segment
	// that PASS/approval bind to, so it no longer invalidates verification or approval. A real
	// contract change (Goal/DoD/Manual/Verification) goes through write/edit and is caught by the
	// contract-hash checks in verify/done/approve.
	// Recording progress clears a stale "why it cannot proceed" note unless this call is parking
	// the task (`waiting`) or states a new reason itself. `lastOutcome` is deliberately untouched:
	// the runtime owns it (attempt claim/finish), so an action never has to keep it in sync.
	if (nextFields.control && request.status !== "waiting" && request.control?.blockedReason === undefined) {
		nextFields.control.blockedReason = undefined;
	}
	const nextBody = appendCurrentCycleNote(body, note);
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, nextBody));
	return {
		action: "progress",
		id,
		path: taskPath,
		status: nextFields.status,
		notice: `已记录任务 \`${id}\` 的进展（status: ${nextFields.status}${nextFields.wake ? `, wake: ${nextFields.wake}` : ""}）。`,
	};
}

export async function doneTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "done" requires an id.');
	const id = normalizeTaskId(request.id);
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("done", id, normalizeStoredStatus(fields.status));
	const uncheckedAcceptance = uncheckedTaskAcceptanceItems(body);
	if (uncheckedAcceptance.length > 0) {
		throw new RecoverableToolError(
			`Task "${id}" still has unchecked acceptance items: ${uncheckedAcceptance.join("; ")}. Check them with evidence before done.`,
		);
	}
	if (fields.control?.sideEffects === "external") {
		if (fields.control.externalApproval === "required") {
			throw new Error(`Task "${id}" requires explicit external-action approval before it can be completed.`);
		}
		if (fields.control.externalApproval === "granted" && fields.control.approvalBodyHash !== taskBodyHash(body)) {
			throw new Error(
				`Task "${id}" changed after external-action approval; ask the user to run /tasks approve ${id} again.`,
			);
		}
	}
	if (fields.control?.verification.required) {
		const verification = fields.control.verification;
		if (verification.status !== "passed" || !verification.bodyHash || !verification.runId) {
			throw new RecoverableToolError(
				`Task "${id}" requires an independent PASS. Run a purpose=verify sub-agent, then task_manage verify with its run id.`,
			);
		}
		if (verification.bodyHash !== taskBodyHash(body)) {
			throw new RecoverableToolError(
				`Task "${id}" changed after its independent PASS; rerun verification before done.`,
			);
		}
		// Read the attestation first: it names the checkout the verifier actually inspected, which
		// is what the subject must be recomputed in (a sub-agent may have been pointed elsewhere).
		const attestation = await assertVerificationAttestationMatches(options.channelDir, id, verification);
		if (verification.subjectHash) {
			// Fail closed (spec 036, D7): an attestation bound to a Git subject that cannot be
			// recomputed is unverifiable, not implicitly fine.
			const subjectDir = attestation.subjectDir ?? options.workingDirectory ?? process.cwd();
			const currentSubject = await workspaceSubjectHash(subjectDir);
			if (!currentSubject) {
				throw new RecoverableToolError(
					`Task "${id}" has an independent PASS bound to the Git artifact subject of ${subjectDir}, but that checkout cannot be read. Restore it, or rerun verification.`,
				);
			}
			if (currentSubject !== verification.subjectHash) {
				throw new RecoverableToolError(
					`Task "${id}" artifacts changed after its independent PASS; rerun verification before done.`,
				);
			}
		}
	}
	// Spec 036 D5: `done` always records Summary/Evidence in the body. It no longer also stamps
	// `verification.status = "passed"` for unverified tasks — that was the maker grading itself,
	// and it made a self-report indistinguishable from a verifier's verdict.
	const bodyWithEvidence = appendCompletionEvidence(body, request);
	if (fields.control) fields.control.blockedReason = undefined;

	// A recurring task (schedule frontmatter) sleeps in place until its next occurrence. The
	// wake is cleared here and refilled to the next cron occurrence by the single time rule
	// (`normalizeTaskFields`) on the write path, so "done + wake" always describes "asleep
	// until next cycle" without a per-action recompute (D1).
	const doneFields: TaskFields = { ...fields, status: "done", wake: undefined };
	await writeFileAtomically(taskPath, renderTaskFile(doneFields, bodyWithEvidence));
	const { deleted } = await cleanupTaskEvents(options, id);

	// Recurring (schedule frontmatter) sleeps in place; one-shot → archive.
	const recurring = Boolean(fields.schedule);
	let archived = false;
	let finalPath = taskPath;
	if (!recurring) {
		const archiveDir = join(dir, "archive");
		await mkdir(archiveDir, { recursive: true });
		finalPath = join(archiveDir, `${id}.md`);
		await rename(taskPath, finalPath);
		archived = true;
	}

	const cleanup = deleted.length > 0 ? `，清理事件 ${deleted.join(", ")}` : "";
	const disposition = archived ? "已归档" : "周期任务留原地待下次唤醒";
	return {
		action: "done",
		id,
		path: finalPath,
		status: "done",
		archived,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已完成（${disposition}${cleanup}）。`,
	};
}

/**
 * Close one recurring occurrence without pretending its DoD was completed.
 *
 * This is the stateful counterpart of a silent/deduplicated wake: merely returning
 * `[SILENT]` would leave the runtime-opened cycle active with no wake and cause retries.
 */
export async function skipTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "skip" requires an id.');
	const id = normalizeTaskId(request.id);
	const reason = requiredField(request.reason, "reason", "skip");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("skip", id, normalizeStoredStatus(fields.status));
	if (!fields.schedule) {
		throw new RecoverableToolError(
			`Task "${id}" is not recurring; use action "cancel" to abandon it or "done" after satisfying its DoD.`,
		);
	}
	const skippedBody = appendCurrentCycleNote(body, `Skipped: ${reason}`);
	if (fields.control) {
		fields.control.blockedReason = undefined;
		fields.control.verification = { required: fields.control.verification.required, status: "pending" };
	}
	await writeFileAtomically(taskPath, renderTaskFile({ ...fields, status: "done", wake: undefined }, skippedBody));
	const { deleted } = await cleanupTaskEvents(options, id);
	return {
		action: "skip",
		id,
		path: taskPath,
		status: "done",
		archived: false,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 本周期已跳过并休眠至下一次计划唤醒；若无需通知用户，请回复 [SILENT]。`,
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
	if (fields.control) fields.control.blockedReason = `Cancelled: ${reason}`;
	const cancelledBody = `${body.replace(/\n+$/, "\n")}\n## Cancellation\n\n- Reason: ${markdownValue(reason)}\n`;
	await writeFileAtomically(
		taskPath,
		renderTaskFile({ ...fields, status: "cancelled", wake: undefined }, cancelledBody),
	);
	const { deleted } = await cleanupTaskEvents(options, id);
	const archiveDir = join(dir, "archive");
	await mkdir(archiveDir, { recursive: true });
	const finalPath = join(archiveDir, `${id}.md`);
	await rename(taskPath, finalPath);
	return {
		action: "cancel",
		id,
		path: finalPath,
		status: "cancelled",
		archived: true,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已取消并归档${deleted.length ? `，清理事件 ${deleted.join(", ")}` : ""}。`,
	};
}

export async function listTasks(options: TaskManageToolOptions): Promise<TaskManageResult> {
	const entries = await readActiveTasks(tasksDir(options));
	return {
		action: "list",
		tasks: entries.map((entry) => ({
			id: entry.id,
			title: entry.title,
			status: entry.frontmatter.readable ? (entry.frontmatter.status ?? "active") : "unreadable",
			wake: entry.frontmatter.wake,
			actionable: entry.actionable,
			control: entry.frontmatter.control,
		})),
		notice: `台账共有 ${entries.length} 个 active 任务。`,
	};
}
