import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { TrialRecord } from "./schema.js";

function findRun(root: string, runId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Invalid run id; use the id printed by eval.");
	const dir = ["results", "baselines"].map((parent) => join(root, "evals", parent, runId)).find(existsSync);
	if (!dir) throw new Error(`Run ${runId} was not found; use an id below evals/results or evals/baselines.`);
	return dir;
}

export function renderDiagnostics(root: string, runId: string): string {
	const dir = findRun(root, runId);
	const records = readFileSync(join(dir, "trials.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TrialRecord);
	const failures = records.filter((record) => record.outcome !== "pass");
	if (!failures.length) return `Run ${runId}: no failed objective trials. No human review is required.`;
	return failures
		.map((record) => {
			const grade = record.grades.find(
				(entry) => entry.authority !== "advisory" && (entry.status === "fail" || entry.status === "error"),
			);
			const stop = record.result?.stopReason;
			const trialDir = join(dir, "trials", `${record.caseId}-${record.trial}`);
			return [
				`${record.caseId}#${record.trial} ${record.result?.execution ?? record.outcome}`,
				stop
					? `  Stop: ${stop.source}/${stop.code} — evidenceComplete=${record.result?.evidenceComplete ?? false}`
					: `  Objective: ${grade?.graderId ?? "unknown"} — ${grade?.rationale ?? "inspect trial record"}`,
				`  Evidence: ${stop?.evidenceId ?? grade?.evidence.map((entry) => entry.ref).join(", ") ?? "record.json"}`,
				`  Probe: npm run eval -- run --case ${record.caseId} --trials 1 --profile dev (fresh evidence; not a frozen replay)`,
				`  Path: ${relative(root, trialDir)}`,
			].join("\n");
		})
		.join("\n\n");
}
