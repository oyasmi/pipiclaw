import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import type { WorkspaceSubjectHashOptions } from "./artifact-subject.js";
import { readStoredTask, taskBodyHash } from "./store.js";

export type VerificationVerdict = "pass" | "fail";
export type VerificationSubjectMode = "legacy-head" | "base-relative";

const FULL_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

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
	/** Git subject that the verifier actually inspected. */
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
	 * New attestations use a fixed base commit and compare the current content relative to it. The
	 * old field-less form is the legacy HEAD-sensitive subject and is retained for compatibility.
	 */
	subjectMode?: VerificationSubjectMode;
	/** Commit recorded before the verifier started, for `subjectMode: "base-relative"`. */
	subjectBaseCommit?: string;
	/** Untracked paths, plus ignored non-transient paths, present at verification start; existing
	 * paths remain protected even when new files under the explicit transient-artifact scope are
	 * allowed. Ignored paths inside that explicit scope are treated as generated at every snapshot. */
	subjectBaselineUntrackedPaths?: string[];
	/**
	 * `enforced` — a built-in verifier that could not write at all: write/edit are structurally
	 * removed before it runs, and its role declared no `bash` either (a real gate). `advisory` —
	 * every other shape: an external verifier (spec 040, D9), whose tools cannot be removed so the
	 * verdict rests on the target CLI's own sandbox flag plus the workspace hash, and a built-in
	 * verifier that kept `bash`, which can write files just as well as `write` can. Defaults to
	 * `enforced` for attestations written before this field existed — every verifier was built-in
	 * and this distinction did not exist then.
	 */
	verificationStrength: "enforced" | "advisory";
}

/**
 * Trusted context supplied by a task consumer from the persisted sub-agent run record. The
 * attestation file is evidence, not the authority for which checkout was verified.
 */
export interface VerificationAttestationReadOptions {
	trustedWorkingDirectory?: string;
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

/** Translate an attestation's subject metadata into the hash options used by verify/close. */
export function getVerificationSubjectHashOptions(
	attestation: Pick<VerificationAttestation, "subjectMode" | "subjectBaseCommit" | "subjectBaselineUntrackedPaths">,
): WorkspaceSubjectHashOptions | undefined {
	if (attestation.subjectMode !== "base-relative" && attestation.subjectBaseCommit === undefined) return undefined;
	if (attestation.subjectBaseCommit === undefined) return undefined;
	if (attestation.subjectMode === "base-relative" && attestation.subjectBaselineUntrackedPaths === undefined)
		return undefined;
	return {
		baseCommit: attestation.subjectBaseCommit,
		baselineUntrackedPaths: attestation.subjectBaselineUntrackedPaths ?? [],
	};
}

export async function writeVerificationAttestation(
	channelDir: string,
	input: Omit<VerificationAttestation, "version" | "bodyHash">,
): Promise<VerificationAttestation> {
	const task = await readStoredTask(channelDir, input.taskId);
	if (!task) throw new Error(`Cannot attest verification: task "${input.taskId}" does not exist.`);
	const hasSubjectHash = input.subjectHash !== undefined;
	const subjectMode = hasSubjectHash
		? (input.subjectMode ?? (input.subjectBaseCommit !== undefined ? "base-relative" : "legacy-head"))
		: input.subjectMode;
	if (
		subjectMode === "base-relative" &&
		(input.subjectBaseCommit === undefined ||
			!FULL_COMMIT_PATTERN.test(input.subjectBaseCommit.trim()) ||
			!input.subjectBaselineUntrackedPaths)
	) {
		throw new Error("Cannot attest verification: base-relative subject metadata is incomplete.");
	}
	if (
		subjectMode === "legacy-head" &&
		(input.subjectBaseCommit !== undefined || input.subjectBaselineUntrackedPaths !== undefined)
	) {
		throw new Error("Cannot attest verification: legacy-head subject cannot carry base-relative metadata.");
	}
	if (
		!hasSubjectHash &&
		(subjectMode !== undefined ||
			input.subjectBaseCommit !== undefined ||
			input.subjectBaselineUntrackedPaths !== undefined)
	) {
		throw new Error("Cannot attest verification: subject metadata requires a subject hash.");
	}
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
		subjectDir: hasSubjectHash ? input.subjectDir : undefined,
		subjectMode,
		subjectBaseCommit: subjectMode === "base-relative" ? input.subjectBaseCommit : undefined,
		subjectBaselineUntrackedPaths:
			subjectMode === "base-relative" ? [...(input.subjectBaselineUntrackedPaths ?? [])] : undefined,
		verificationStrength: input.verificationStrength,
	};
	await mkdir(verificationDir(channelDir), { recursive: true });
	await writeFileAtomically(
		verificationAttestationPath(channelDir, input.runId),
		`${JSON.stringify(attestation, null, 2)}\n`,
	);
	return attestation;
}

function canonicalDirectory(path: string): string | undefined {
	try {
		const canonical = realpathSync(path);
		return statSync(canonical).isDirectory() ? canonical : undefined;
	} catch {
		return undefined;
	}
}

function bindSubjectDirectory(
	runId: string,
	subjectDir: string | undefined,
	options: VerificationAttestationReadOptions | undefined,
): string | undefined {
	if (!options || subjectDir === undefined) return subjectDir;
	if (!options.trustedWorkingDirectory) {
		throw new Error(
			`Verification run "${runId}" has a subjectDir but no persisted workingDirectory is available; refusing to trust this attestation. Rerun the verifier.`,
		);
	}
	const canonicalSubjectDir = canonicalDirectory(subjectDir);
	const canonicalWorkingDirectory = canonicalDirectory(options.trustedWorkingDirectory);
	if (!canonicalSubjectDir || !canonicalWorkingDirectory || canonicalSubjectDir !== canonicalWorkingDirectory) {
		throw new Error(
			`Verification run "${runId}" subjectDir does not match its persisted workingDirectory; refusing to trust this attestation. Rerun the verifier.`,
		);
	}
	return canonicalSubjectDir;
}

export async function readVerificationAttestation(
	channelDir: string,
	runId: string,
	options?: VerificationAttestationReadOptions,
): Promise<VerificationAttestation> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(verificationAttestationPath(channelDir, runId), "utf-8"));
	} catch (error) {
		throw new Error(
			`Verification run "${runId}" was not found or is unreadable. Run a subagent with purpose=verify and taskId first. ${errorMessage(error)}`,
		);
	}
	const raw = (typeof value === "object" && value !== null ? value : {}) as {
		version?: unknown;
		runId?: unknown;
		taskId?: unknown;
		verdict?: unknown;
		checkedAt?: unknown;
		bodyHash?: unknown;
		evidence?: unknown;
		workspaceChanged?: unknown;
		subjectHash?: unknown;
		subjectDir?: unknown;
		subjectMode?: unknown;
		subjectBaseCommit?: unknown;
		subjectBaselineUntrackedPaths?: unknown;
		verificationStrength?: unknown;
	};
	const subjectMode =
		raw.subjectMode !== undefined
			? raw.subjectMode
			: raw.subjectBaseCommit !== undefined
				? "base-relative"
				: "legacy-head";
	const safeSubjectPath = (path: string): boolean => {
		const normalized = path.replaceAll("\\", "/");
		return (
			path.length > 0 &&
			!isAbsolute(path) &&
			!win32.isAbsolute(path) &&
			!path.includes("\0") &&
			!normalized.split("/").includes("..")
		);
	};
	if (
		typeof value !== "object" ||
		value === null ||
		raw.version !== 1 ||
		raw.runId !== runId ||
		typeof raw.taskId !== "string" ||
		(raw.verdict !== "pass" && raw.verdict !== "fail") ||
		typeof raw.checkedAt !== "string" ||
		parseLocalTime(raw.checkedAt) === undefined ||
		!/^[a-f0-9]{64}$/i.test(String(raw.bodyHash)) ||
		typeof raw.evidence !== "string" ||
		typeof raw.workspaceChanged !== "boolean" ||
		(raw.subjectHash !== undefined && !/^[a-f0-9]{64}$/i.test(String(raw.subjectHash))) ||
		(raw.subjectDir !== undefined && typeof raw.subjectDir !== "string") ||
		(raw.subjectMode !== undefined && subjectMode !== "legacy-head" && subjectMode !== "base-relative") ||
		(raw.subjectBaseCommit !== undefined &&
			(typeof raw.subjectBaseCommit !== "string" || !FULL_COMMIT_PATTERN.test(raw.subjectBaseCommit.trim()))) ||
		(raw.subjectBaselineUntrackedPaths !== undefined &&
			(!Array.isArray(raw.subjectBaselineUntrackedPaths) ||
				raw.subjectBaselineUntrackedPaths.some((path) => typeof path !== "string" || !safeSubjectPath(path)))) ||
		(raw.subjectHash === undefined &&
			(raw.subjectMode !== undefined ||
				raw.subjectBaseCommit !== undefined ||
				raw.subjectBaselineUntrackedPaths !== undefined)) ||
		(raw.subjectHash !== undefined &&
			(subjectMode === "base-relative"
				? typeof raw.subjectBaseCommit !== "string" || !Array.isArray(raw.subjectBaselineUntrackedPaths)
				: raw.subjectBaseCommit !== undefined || raw.subjectBaselineUntrackedPaths !== undefined)) ||
		(raw.verificationStrength !== undefined &&
			raw.verificationStrength !== "enforced" &&
			raw.verificationStrength !== "advisory")
	) {
		throw new Error(`Verification run "${runId}" has an invalid attestation. Run the verifier again.`);
	}
	// Pre-spec-040 attestations predate this field; every verifier back then was built-in. When an
	// old attestation also lacks subjectDir, consumers may keep its legacy subject semantics. A
	// subjectDir-bearing attestation is newer and, when read by task lifecycle code, must be bound to
	// a still-available persisted run record instead of choosing an arbitrary checkout.
	const attestation: VerificationAttestation = {
		...(value as VerificationAttestation),
		subjectMode: subjectMode as VerificationSubjectMode,
		verificationStrength: (value as VerificationAttestation).verificationStrength ?? "enforced",
	};
	const boundSubjectDir = bindSubjectDirectory(runId, attestation.subjectDir, options);
	return boundSubjectDir === attestation.subjectDir ? attestation : { ...attestation, subjectDir: boundSubjectDir };
}
