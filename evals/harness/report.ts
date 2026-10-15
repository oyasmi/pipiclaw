import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDetailedReport, renderReport } from "./report-render.js";
import type { CaseSummary, HumanReviewRecord, RunManifest, ScoringPlan, TrialRecord } from "./schema.js";

/** Refresh derived reports only; historical labels are optional, never a prerequisite. */
export function rerenderReport(root: string, run: string): { path: string; detailsPath: string; reviews: number } {
	if (!/^[A-Za-z0-9_-]+$/.test(run)) throw new Error("Invalid run id; use the id printed by eval.");
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
	const summaries = read<{ cases: CaseSummary[] }>("summary.json").cases;
	const manifest = read<RunManifest>("manifest.json");
	const plan = existsSync(join(dir, "scoring-plan.json")) ? read<ScoringPlan>("scoring-plan.json") : undefined;
	const report = renderReport(
		manifest,
		summaries,
		records,
		reviews,
		plan,
		existsSync(join(dir, "credential-scan-failure.txt")),
	);
	const path = join(dir, "report.md");
	writeFileSync(path, report);
	const detailsPath = join(dir, "details.md");

	writeFileSync(detailsPath, renderDetailedReport(manifest, summaries, records, reviews, plan));
	return { path, detailsPath, reviews: reviews.length };
}

const invokedAsScript = process.argv[1]?.endsWith("/report.js") || process.argv[1]?.endsWith("\\report.js");
if (invokedAsScript) {
	const run = process.argv[2] ?? process.env.EVAL_RUN;
	if (!run) throw new Error("Use npm run eval:report -- <runId>.");
	const { path, reviews } = rerenderReport(process.cwd(), run);
	process.stdout.write(`Rewrote ${path}; preserved ${reviews} historical annotation(s).\n`);
}
