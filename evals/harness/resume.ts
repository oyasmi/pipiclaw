import { existsSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { verifyArtifacts } from "./artifacts.js";
import type { CaseDescriptor, TrialRecord } from "./schema.js";

/** Final failures are evidence too: never rerun them in place to manufacture a green run. */
export function completedTrial(
	trialDir: string,
	runId: string,
	descriptor: CaseDescriptor,
	trial: number,
): TrialRecord | undefined {
	const path = join(trialDir, "record.json");
	if (!existsSync(path)) return;
	const record = JSON.parse(readFileSync(path, "utf8")) as TrialRecord;
	if (
		record.runId !== runId ||
		record.caseId !== descriptor.id ||
		record.caseHash !== descriptor.caseHash ||
		record.trial !== trial ||
		(record.observedModel !== "not-started" && !record.configHashes)
	)
		throw new Error("Saved trial does not match the frozen slot; restore its original record before resuming.");
	if (record.observedModel === "not-started") return;
	return record;
}

/** Preserve partial trace and artifacts under a distinct attempt before restarting a slot. */
export function preserveInterruptedAttempt(trialDir: string): string | undefined {
	if (!existsSync(trialDir)) return;
	if (existsSync(join(trialDir, "record.json"))) {
		const record = JSON.parse(readFileSync(join(trialDir, "record.json"), "utf8")) as TrialRecord;
		if (record.observedModel !== "not-started")
			throw new Error("A completed trial must not be replaced; start a new run for a fresh attempt.");
	}
	let attempt = 1;
	while (existsSync(`${trialDir}.interrupted-${attempt}`)) attempt++;
	const archived = `${trialDir}.interrupted-${attempt}`;
	renameSync(trialDir, archived);
	return archived;
}

export function nextAttemptNumber(trialDir: string): number {
	let interrupted = 0;
	while (existsSync(`${trialDir}.interrupted-${interrupted + 1}`)) interrupted++;
	return interrupted + 1;
}

/** A missing final record cannot establish how many tokens a previously started worker used. */
export function recoverAdmissionTokens(trialDir: string, record: TrialRecord | undefined): number {
	const parent = dirname(trialDir);
	const archived = existsSync(parent)
		? readdirSync(parent).filter((name) => name.startsWith(`${basename(trialDir)}.interrupted-`))
		: [];
	const incompleteAttempt =
		(!record && existsSync(join(trialDir, "started.json"))) ||
		archived.some((name) => existsSync(join(parent, name, "started.json")));
	if (
		incompleteAttempt ||
		(record &&
			(typeof record.admissionTokens !== "number" ||
				!Number.isFinite(record.admissionTokens) ||
				record.admissionTokens < 0))
	)
		throw new Error(
			"Cannot resume a token-capped run because prior usage is incomplete. Start a new plan. Model requests: 0.",
		);
	if (record) verifyArtifacts(trialDir, ["record.json", "agent-usage.json"]);
	return record?.admissionTokens ?? 0;
}
