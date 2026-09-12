import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
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
		!record.configHashes
	)
		throw new Error("Saved trial does not match the frozen slot; restore its original record before resuming.");
	return record;
}

/** Preserve partial trace and artifacts under a distinct attempt before restarting a slot. */
export function preserveInterruptedAttempt(trialDir: string): string | undefined {
	if (!existsSync(trialDir)) return;
	if (existsSync(join(trialDir, "record.json")))
		throw new Error("A completed trial must not be replaced; start a new run for a fresh attempt.");
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
