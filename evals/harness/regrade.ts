import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { allCases } from "../cases/index.js";
import { atomicJson, verifyArtifacts } from "./artifacts.js";
import { caseHash } from "./cases.js";
import type { EvalCase, OutcomeSnapshot, TraceEvent, TrialContext, TrialRecord } from "./schema.js";
import { assessTrial, gradeTrial, resultOutcome } from "./scoring.js";
import { hashFile } from "./util.js";

/** Regrade code oracles on verified copies; this function never starts an agent or judge. */
export async function regradeTrial(trialDir: string, item: EvalCase, assessmentDir: string): Promise<string> {
	const index = verifyArtifacts(trialDir, ["record.json", "outcome.json", "trace.jsonl"]);
	if (existsSync(assessmentDir))
		throw new Error("Assessment already exists; choose a new assessment id to preserve prior grades.");
	const recordPath = join(trialDir, "record.json");
	const original = JSON.parse(readFileSync(recordPath, "utf8")) as TrialRecord;
	if (original.caseId !== item.id || !original.result || original.archiveComplete !== true)
		throw new Error("Legacy or incomplete trial cannot be replayed; collect complete evidence in a new run.");
	const homeDir = mkdtempSync(join(tmpdir(), "eval-regrade-"));
	try {
		const workspaceDir = join(homeDir, "workspace");
		const channelRelative = relative(index.mounts.workspaceDir, index.mounts.channelDir);
		if (isAbsolute(channelRelative) || channelRelative.startsWith(".."))
			throw new Error("Invalid archived channel mount; restore the original artifact index.");
		const channelDir = join(workspaceDir, channelRelative);
		for (const entry of index.entries) {
			if (entry.status !== "complete" || (!entry.id.startsWith("workspace/") && !entry.id.startsWith("channel/")))
				continue;
			const root = entry.id.startsWith("workspace/") ? workspaceDir : channelDir;
			const target = resolve(root, entry.id.slice(entry.id.indexOf("/") + 1));
			const rel = relative(homeDir, target);
			if (isAbsolute(rel) || rel.startsWith(".."))
				throw new Error("Archived artifact mapping escapes the replay home; repair the artifact index.");
			mkdirSync(dirname(target), { recursive: true });
			copyFileSync(join(trialDir, entry.path), target);
		}
		const rebase = (value: unknown): unknown => {
			if (typeof value === "string") return value.split(index.mounts.homeDir).join(homeDir);
			if (Array.isArray(value)) return value.map(rebase);
			if (value && typeof value === "object")
				return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rebase(child)]));
			return value;
		};
		const snapshot = rebase(JSON.parse(readFileSync(join(trialDir, "outcome.json"), "utf8"))) as OutcomeSnapshot;
		const trace = readFileSync(join(trialDir, "trace.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => rebase(JSON.parse(line)) as TraceEvent);
		const context: TrialContext = {
			homeDir,
			workspaceDir,
			channelDir,
			trace,
			deliveries: snapshot.deliveries,
			snapshot,
		};
		const grades = await gradeTrial(item, context, original.result.execution, async (grader) => ({
			schemaVersion: 1,
			graderId: grader.graderId,
			graderVersion: grader.graderVersion,
			graderKind: "model",
			status: "skipped",
			severity: grader.severity ?? "quality",
			evidence: [],
			rationale: "Code-only regrade; run a separately budgeted judge assessment for this rubric.",
		}));
		grades.push(
			...original.grades.filter((grade) => ["product-runtime", "harness-protocol"].includes(grade.graderId)),
		);
		const result = assessTrial(
			grades,
			original.result.execution,
			original.result.evidenceComplete,
			original.result.stopReason,
		);
		mkdirSync(assessmentDir, { recursive: true });
		const path = join(assessmentDir, "assessment.json");
		atomicJson(path, {
			schemaVersion: 1,
			sourceRecordHash: hashFile(recordPath),
			sourceArtifactIndexHash: hashFile(join(trialDir, "artifact-index.json")),
			originalCaseHash: original.caseHash,
			graderCaseHash: caseHash(item),
			modelRequests: 0,
			result,
			outcome: resultOutcome(result),
			grades,
		});
		return path;
	} finally {
		rmSync(homeDir, { recursive: true, force: true });
	}
}

export async function regradeRun(root: string, runId: string): Promise<string> {
	if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid run id; use the id printed by eval.");
	const source = ["results", "baselines"].map((dir) => join(root, "evals", dir, runId)).find((dir) => existsSync(dir));
	if (!source) throw new Error("Run not found; use a recorded run id from evals/results or evals/baselines.");
	const records = readFileSync(join(source, "trials.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TrialRecord);
	const output = join(root, "evals", "results", `regrade-${runId}-${Date.now()}`);
	mkdirSync(output, { recursive: true });
	const assessments: string[] = [];
	for (const record of records) {
		const item = allCases.find((item) => item.id === record.caseId);
		if (!item)
			throw new Error(`Current oracle for ${record.caseId} is missing; restore its case module before regrading.`);
		assessments.push(
			await regradeTrial(
				join(source, "trials", `${record.caseId}-${record.trial}`),
				item,
				join(output, `${record.caseId}-${record.trial}`),
			),
		);
	}
	writeFileSync(
		join(output, "report.md"),
		`# Code-only regrade of ${runId}\n\nOriginal grades are unchanged. Model graders are skipped; this is not a promotable replacement run.\n\n${assessments.map((path) => `- [assessment](${relative(output, path)})`).join("\n")}\n`,
	);
	return output;
}

if (process.argv[1]?.endsWith("/regrade.js")) {
	const runId = process.argv[2];
	if (!runId) throw new Error("Use npm run eval:regrade -- <runId>.");
	regradeRun(process.cwd(), runId)
		.then((dir) => process.stdout.write(`${dir}\n`))
		.catch((error) => {
			process.stderr.write(`${String(error)}\n`);
			process.exitCode = 2;
		});
}
