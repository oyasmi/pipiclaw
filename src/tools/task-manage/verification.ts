import { writeFileAtomically } from "../../shared/atomic-file.js";
import { workspaceSubjectHash } from "../../tasks/artifact-subject.js";
import { createDefaultTaskControl } from "../../tasks/control.js";
import { normalizeTaskId } from "../../tasks/ledger.js";
import { readStoredTask, taskBodyHash } from "../../tasks/store.js";
import { normalizeStoredStatus, resolveTaskTransition } from "../../tasks/transitions.js";
import { readVerificationAttestation, type VerificationAttestation } from "../../tasks/verification.js";
import { RecoverableToolError } from "../tool-details.js";
import { renderTaskFile, requiredField } from "./shared.js";
import type { TaskManageRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";

/**
 * Import a verifier's attestation. The task's own lifecycle status is not the authorization
 * check — a real, matching, on-disk attestation for this task id is (spec 040's threat model:
 * the task Markdown is agent-writable and proves nothing). `verify` works whether the task is
 * still `waiting` (e.g. called right after its completion wake reactivated it) or already
 * `active`.
 */
export async function verifyTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	if (!request.id) throw new RecoverableToolError('action "verify" requires an id.');
	const id = normalizeTaskId(request.id);
	const runId = requiredField(request.verifierRunId, "verifierRunId", "verify");
	const task = await readStoredTask(options.channelDir, id);
	if (!task) throw new RecoverableToolError(`Task "${id}" does not exist; create it before verification.`);
	resolveTaskTransition("verify", id, normalizeStoredStatus(task.fields.status));
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
		const currentSubject = await workspaceSubjectHash(
			attestation.subjectDir ?? options.workingDirectory ?? process.cwd(),
		);
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
	const control = task.fields.control ?? createDefaultTaskControl(true);
	control.verification = {
		required: true,
		status: attestation.verdict === "pass" ? "passed" : "failed",
		runId,
	};
	control.waitingFor = undefined;
	control.nextAction = undefined;
	task.fields.control = control;
	task.fields.status = "active";
	task.fields.wake = undefined;
	await writeFileAtomically(task.path, renderTaskFile(task.fields, task.body));
	return {
		action: "verify",
		id,
		path: task.path,
		status: "active",
		notice: `任务 \`${id}\` 独立验收结果：${attestation.verdict.toUpperCase()}（run: ${runId}）。`,
	};
}

/**
 * `verify` writes control.verification from a real attestation file, but the task Markdown
 * itself is writable by the agent's own write/edit tools — nothing stops it from hand-crafting
 * a "passed" verification block that was never backed by a real verifier run. Re-check the
 * attestation file on the consuming side (complete/doctor) too, not just at import time, and
 * against the task's *current* body hash directly — not a mirrored value the task file could
 * itself have drifted.
 */
export async function assertVerificationAttestationMatches(
	channelDir: string,
	id: string,
	runId: string | undefined,
	currentBodyHash: string,
): Promise<VerificationAttestation> {
	if (!runId) {
		throw new RecoverableToolError(
			`Task "${id}" has no verification run id; rerun task_manage verify before complete.`,
		);
	}
	const attestation = await readVerificationAttestation(channelDir, runId);
	if (attestation.taskId !== id) {
		throw new RecoverableToolError(
			`Verification run "${runId}" belongs to task "${attestation.taskId}", not "${id}"; rerun verification.`,
		);
	}
	if (attestation.verdict !== "pass") {
		throw new RecoverableToolError(`Verification run "${runId}" recorded a FAIL, not a PASS; rerun verification.`);
	}
	if (attestation.bodyHash !== currentBodyHash) {
		throw new RecoverableToolError(
			`Task "${id}" changed since verification run "${runId}"; rerun task_manage verify.`,
		);
	}
	return attestation;
}
