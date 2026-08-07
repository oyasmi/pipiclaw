import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { readStoredTask, taskBodyHash } from "./store.js";

export type VerificationVerdict = "pass" | "fail";

/**
 * A verifier's verdict, recorded on disk beside the task (spec 036, D6).
 *
 * This file is the anti-self-certification core: the task Markdown is writable by the agent's
 * own write/edit tools, so a hand-written `status: "passed"` proves nothing. Every field here
 * is re-checked at `complete`, which is why the set is exactly the fields something reads —
 * `agent`, `model` and `outputHash` were stored and strictly validated but never once
 * consulted, so they are gone.
 */
export interface VerificationAttestation {
	version: 1;
	runId: string;
	taskId: string;
	verdict: VerificationVerdict;
	checkedAt: string;
	bodyHash: string;
	evidence: string;
	workspaceChanged: boolean;
	/** Git HEAD + working-tree subject that the verifier actually inspected. */
	subjectHash?: string;
	/**
	 * The checkout `subjectHash` was computed in. Recorded so `verify` and `complete` recompute the
	 * subject where the verifier looked, not wherever the daemon happens to be running: a
	 * sub-agent may be pointed at another checkout via `workingDirectory`, and comparing that
	 * verdict against the daemon's own cwd would either fail closed forever or — worse — compare
	 * a PASS against an unrelated repository. Absent on attestations written before this field.
	 */
	subjectDir?: string;
	/**
	 * `enforced` — a built-in verifier, whose write/edit tools are structurally removed before it
	 * runs (a real gate). `advisory` — an external verifier (spec 040, D9): the tools cannot be
	 * removed, so the verdict rests on the target CLI's own sandbox flag plus the workspace hash,
	 * neither of which pipiclaw can prove. Defaults to `enforced` for attestations written before
	 * this field existed — every verifier was built-in then.
	 */
	verificationStrength: "enforced" | "advisory";
}

function attestationFilename(runId: string): string {
	return `${createHash("sha256").update(runId).digest("hex")}.json`;
}

export function verificationDir(channelDir: string): string {
	return join(channelDir, "tasks", ".verifications");
}

export function verificationAttestationPath(channelDir: string, runId: string): string {
	return join(verificationDir(channelDir), attestationFilename(runId));
}

export function parseVerificationVerdict(output: string): VerificationVerdict | undefined {
	const value = /(?:^|\n)VERDICT:\s*(PASS|FAIL)\s*$/i.exec(output.trim())?.[1]?.toLowerCase();
	return value === "pass" || value === "fail" ? value : undefined;
}

export async function writeVerificationAttestation(
	channelDir: string,
	input: Omit<VerificationAttestation, "version" | "bodyHash">,
): Promise<VerificationAttestation> {
	const task = await readStoredTask(channelDir, input.taskId);
	if (!task) throw new Error(`Cannot attest verification: task "${input.taskId}" does not exist.`);
	const attestation: VerificationAttestation = {
		version: 1,
		runId: input.runId,
		taskId: input.taskId,
		verdict: input.verdict,
		checkedAt: input.checkedAt,
		bodyHash: taskBodyHash(task.body),
		evidence: input.evidence,
		workspaceChanged: input.workspaceChanged,
		subjectHash: input.subjectHash,
		subjectDir: input.subjectHash ? input.subjectDir : undefined,
		verificationStrength: input.verificationStrength,
	};
	await mkdir(verificationDir(channelDir), { recursive: true });
	await writeFileAtomically(
		verificationAttestationPath(channelDir, input.runId),
		`${JSON.stringify(attestation, null, 2)}\n`,
	);
	return attestation;
}

export async function readVerificationAttestation(channelDir: string, runId: string): Promise<VerificationAttestation> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(verificationAttestationPath(channelDir, runId), "utf-8"));
	} catch (error) {
		throw new Error(
			`Verification run "${runId}" was not found or is unreadable. Run a subagent with purpose=verify and taskId first. ${errorMessage(error)}`,
		);
	}
	if (
		typeof value !== "object" ||
		value === null ||
		(value as { version?: unknown }).version !== 1 ||
		(value as { runId?: unknown }).runId !== runId ||
		typeof (value as { taskId?: unknown }).taskId !== "string" ||
		((value as { verdict?: unknown }).verdict !== "pass" && (value as { verdict?: unknown }).verdict !== "fail") ||
		typeof (value as { checkedAt?: unknown }).checkedAt !== "string" ||
		parseLocalTime((value as { checkedAt: string }).checkedAt) === undefined ||
		!/^[a-f0-9]{64}$/i.test(String((value as { bodyHash?: unknown }).bodyHash)) ||
		typeof (value as { evidence?: unknown }).evidence !== "string" ||
		typeof (value as { workspaceChanged?: unknown }).workspaceChanged !== "boolean" ||
		((value as { subjectHash?: unknown }).subjectHash !== undefined &&
			!/^[a-f0-9]{64}$/i.test(String((value as { subjectHash?: unknown }).subjectHash))) ||
		((value as { subjectDir?: unknown }).subjectDir !== undefined &&
			typeof (value as { subjectDir?: unknown }).subjectDir !== "string") ||
		((value as { verificationStrength?: unknown }).verificationStrength !== undefined &&
			(value as { verificationStrength?: unknown }).verificationStrength !== "enforced" &&
			(value as { verificationStrength?: unknown }).verificationStrength !== "advisory")
	) {
		throw new Error(`Verification run "${runId}" has an invalid attestation. Run the verifier again.`);
	}
	// Pre-spec-040 attestations predate this field; every verifier back then was built-in.
	return {
		...(value as VerificationAttestation),
		verificationStrength: (value as VerificationAttestation).verificationStrength ?? "enforced",
	};
}
