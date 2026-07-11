import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { errorMessage } from "../shared/text-utils.js";
import { readStoredTask, taskBodyHash } from "./store.js";

export type VerificationVerdict = "pass" | "fail";

export interface VerificationAttestation {
	version: 1;
	runId: string;
	taskId: string;
	verdict: VerificationVerdict;
	agent: string;
	model: string;
	checkedAt: string;
	bodyHash: string;
	evidence: string;
	outputHash: string;
	workspaceChanged: boolean;
	/** Git HEAD + working-tree subject that the verifier actually inspected. */
	subjectHash?: string;
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
	input: Omit<VerificationAttestation, "version" | "bodyHash" | "outputHash"> & { output: string },
): Promise<VerificationAttestation> {
	const task = await readStoredTask(channelDir, input.taskId);
	if (!task) throw new Error(`Cannot attest verification: task "${input.taskId}" does not exist.`);
	const attestation: VerificationAttestation = {
		version: 1,
		runId: input.runId,
		taskId: input.taskId,
		verdict: input.verdict,
		agent: input.agent,
		model: input.model,
		checkedAt: input.checkedAt,
		bodyHash: taskBodyHash(task.body),
		evidence: input.evidence,
		outputHash: createHash("sha256").update(input.output).digest("hex"),
		workspaceChanged: input.workspaceChanged,
		subjectHash: input.subjectHash,
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
		typeof (value as { agent?: unknown }).agent !== "string" ||
		typeof (value as { model?: unknown }).model !== "string" ||
		typeof (value as { checkedAt?: unknown }).checkedAt !== "string" ||
		!Number.isFinite(new Date((value as { checkedAt: string }).checkedAt).getTime()) ||
		!/^[a-f0-9]{64}$/i.test(String((value as { bodyHash?: unknown }).bodyHash)) ||
		!/^[a-f0-9]{64}$/i.test(String((value as { outputHash?: unknown }).outputHash)) ||
		typeof (value as { evidence?: unknown }).evidence !== "string" ||
		typeof (value as { workspaceChanged?: unknown }).workspaceChanged !== "boolean" ||
		((value as { subjectHash?: unknown }).subjectHash !== undefined &&
			!/^[a-f0-9]{64}$/i.test(String((value as { subjectHash?: unknown }).subjectHash)))
	) {
		throw new Error(`Verification run "${runId}" has an invalid attestation. Run the verifier again.`);
	}
	return value as VerificationAttestation;
}
