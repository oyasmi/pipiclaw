import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport } from "./run.js";
import type { CaseSummary, HumanReviewRecord, RunManifest, TrialRecord } from "./schema.js";

/**
 * Re-render an archived run's `report.md`.
 *
 * Human review is the only path by which a model grader can ever be trusted enough to guard a
 * gate, and it is inherently after the fact: a reviewer records verdicts in `human-review.jsonl`
 * hours after the run finished. Without this command the run's report was written once, before
 * any verdict existed, so calibration was permanently "pending" and nobody had a reason to fill
 * the queue in. Archived grades stay immutable — only the rendering is recomputed.
 */
export function rerenderReport(root: string, run: string): { path: string; reviews: number } {
	const dir = ["results", "baselines"]
		.map((parent) => join(root, "evals", parent, run))
		.find((candidate) => existsSync(candidate));
	if (!dir) throw new Error(`Run ${run} not found in evals/results or evals/baselines.`);
	const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
	const records = readFileSync(join(dir, "trials.jsonl"), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TrialRecord);
	const reviewPath = join(dir, "human-review.jsonl");
	const reviews = existsSync(reviewPath)
		? readFileSync(reviewPath, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => JSON.parse(line) as HumanReviewRecord)
		: [];
	const report = renderReport(
		read<RunManifest>("manifest.json"),
		read<{ cases: CaseSummary[] }>("summary.json").cases,
		records,
		reviews,
	);
	const path = join(dir, "report.md");
	writeFileSync(path, report);
	return { path, reviews: reviews.length };
}

const invokedAsScript = process.argv[1]?.endsWith("/report.js") || process.argv[1]?.endsWith("\\report.js");
if (invokedAsScript) {
	const run = process.argv[2] ?? process.env.EVAL_RUN;
	if (!run) throw new Error("Use npm run eval:report -- <runId>.");
	const { path, reviews } = rerenderReport(process.cwd(), run);
	process.stdout.write(`Rewrote ${path} with ${reviews} human-review verdict(s).\n`);
}
