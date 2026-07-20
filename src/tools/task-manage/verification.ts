import { join } from "node:path";
import { writeFileAtomically } from "../../shared/atomic-file.js";
import { appendCurrentCycleNote, normalizeTaskId, uncheckedTaskAcceptanceItems } from "../../shared/task-ledger.js";
import { workspaceSubjectHash } from "../../tasks/artifact-subject.js";
import { createDefaultTaskControl, type TaskVerification } from "../../tasks/control.js";
import { readStoredTask, taskBodyHash } from "../../tasks/store.js";
import { normalizeStoredStatus, resolveTaskTransition } from "../../tasks/transitions.js";
import { readVerificationAttestation } from "../../tasks/verification.js";
import { RecoverableToolError } from "../tool-details.js";
import { readTaskDocument, renderTaskFile, requiredField, tasksDir } from "./shared.js";
import type { TaskManageRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";

/**
 * Move a task into the verification lane. The runtime driver will explicitly
 * wake a fresh verifier on the next attempt, keeping the maker from grading
 * its own work in the same reasoning context.
 */
export async function candidateTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "candidate" requires an id.');
	const id = normalizeTaskId(request.id);
	const note = requiredField(request.note, "note", "candidate");
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	resolveTaskTransition("candidate", id, normalizeStoredStatus(fields.status));
	const uncheckedAcceptance = uncheckedTaskAcceptanceItems(body);
	if (uncheckedAcceptance.length > 0) {
		throw new RecoverableToolError(
			`Task "${id}" still has unchecked acceptance items: ${uncheckedAcceptance.join("; ")}. Check them with evidence before requesting verification.`,
		);
	}
	const control = fields.control ?? createDefaultTaskControl("independent");
	control.verification = { mode: "independent", status: "pending" };
	control.lastOutcome = "progress";
	control.blockedReason = undefined;
	control.nextAction = "Run a purpose=verify sub-agent and import its attestation.";
	const nextBody = appendCurrentCycleNote(body, note);
	await writeFileAtomically(
		taskPath,
		renderTaskFile({ ...fields, status: "verifying", wake: undefined, control }, nextBody),
	);
	return {
		action: "candidate",
		id,
		path: taskPath,
		status: "verifying",
		notice: `任务 \`${id}\` 已进入独立验收队列；driver 将安排 verifier。`,
	};
}

export async function verifyTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "verify" requires an id.');
	const id = normalizeTaskId(request.id);
	const runId = requiredField(request.verifierRunId, "verifierRunId", "verify");
	const task = await readStoredTask(options.channelDir, id);
	if (!task) throw new RecoverableToolError(`Task "${id}" does not exist; create it before verification.`);
	const attestation = await readVerificationAttestation(options.channelDir, runId);
	if (attestation.taskId !== id) {
		throw new RecoverableToolError(
			`Verification run "${runId}" belongs to task "${attestation.taskId}", not "${id}".`,
		);
	}
	if (attestation.workspaceChanged) {
		throw new RecoverableToolError(`Verification run "${runId}" changed the workspace; rerun a read-only verifier.`);
	}
	if (attestation.bodyHash !== taskBodyHash(task.body)) {
		throw new RecoverableToolError(
			`Task "${id}" changed after verification run "${runId}"; rerun the verifier on current content.`,
		);
	}
	if (attestation.subjectHash) {
		const currentSubject = await workspaceSubjectHash(options.workingDirectory ?? process.cwd());
		if (!currentSubject) {
			throw new RecoverableToolError(
				`Verification run "${runId}" is bound to a Git artifact subject, but the current checkout cannot be read. Rerun verification from the project checkout.`,
			);
		}
		if (currentSubject !== attestation.subjectHash) {
			throw new RecoverableToolError(
				`Task "${id}" artifacts changed after verification run "${runId}"; rerun the verifier.`,
			);
		}
	}
	const control = task.fields.control ?? createDefaultTaskControl("independent");
	control.verification = {
		mode: "independent",
		status: attestation.verdict === "pass" ? "passed" : "failed",
		runId,
		evidence: attestation.evidence,
		bodyHash: attestation.bodyHash,
		subjectHash: attestation.subjectHash,
		checkedAt: attestation.checkedAt,
	};
	control.lastOutcome = attestation.verdict === "pass" ? "verified" : "failed";
	control.blockedReason = attestation.verdict === "fail" ? attestation.evidence : undefined;
	task.fields.control = control;
	await writeFileAtomically(task.path, renderTaskFile(task.fields, task.body));
	return {
		action: "verify",
		id,
		path: task.path,
		status: task.fields.status,
		notice: `任务 \`${id}\` 独立验收结果：${attestation.verdict.toUpperCase()}（run: ${runId}）。`,
	};
}

/**
 * `verify` writes control.verification from a real attestation file, but the task Markdown
 * itself is writable by the agent's own write/edit tools — nothing stops it from hand-crafting
 * a "passed" verification block that was never backed by a real verifier run. Re-check the
 * attestation file on the consuming side (done/doctor) too, not just at import time.
 */
export async function assertVerificationAttestationMatches(
	channelDir: string,
	id: string,
	verification: TaskVerification,
): Promise<void> {
	if (!verification.runId) {
		throw new RecoverableToolError(`Task "${id}" has no verification run id; rerun task_manage verify before done.`);
	}
	const attestation = await readVerificationAttestation(channelDir, verification.runId);
	if (attestation.taskId !== id) {
		throw new RecoverableToolError(
			`Verification run "${verification.runId}" belongs to task "${attestation.taskId}", not "${id}"; rerun verification.`,
		);
	}
	if (attestation.verdict !== "pass") {
		throw new RecoverableToolError(
			`Verification run "${verification.runId}" recorded a FAIL, not a PASS; rerun verification.`,
		);
	}
	if (attestation.bodyHash !== verification.bodyHash) {
		throw new RecoverableToolError(
			`Task "${id}" control.verification.bodyHash does not match the attestation for run "${verification.runId}"; rerun task_manage verify.`,
		);
	}
}
