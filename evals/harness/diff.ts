import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseSummary, RunManifest } from "./schema.js";

interface FrozenSummary {
	schemaVersion: 1;
	cases: CaseSummary[];
}

function runDir(run: string): string {
	const root = process.cwd();
	if (run === "baseline" || run === "latest") {
		const latest = JSON.parse(readFileSync(join(root, "evals/baselines/latest.json"), "utf8")) as { runId: string };
		return join(root, "evals/baselines", latest.runId);
	}
	for (const parent of ["results", "baselines"]) {
		const candidate = join(root, "evals", parent, run);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`Run ${run} not found in evals/results or evals/baselines. Run eval or promote a baseline first.`);
}

function read<T>(dir: string, file: string): T {
	return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
}

function conditionRows(a: RunManifest, b: RunManifest): string[] {
	const fields = [
		["git", a.gitSha, b.gitSha],
		["dirty diff", a.gitDirtyDiffHash ?? "clean", b.gitDirtyDiffHash ?? "clean"],
		["model", a.configuredModel, b.configuredModel],
		["settings", a.settingsHash, b.settingsHash],
		["tools", a.toolsConfigHash, b.toolsConfigHash],
		["security", a.securityConfigHash, b.securityConfigHash],
		["judge", a.judgeModel ?? "none", b.judgeModel ?? "none"],
	] as const;
	return fields.map(([name, left, right]) => `| ${name} | ${left} | ${right} | ${left === right ? "yes" : "no"} |`);
}

export function renderDiff(
	leftName: string,
	rightName: string,
	a: RunManifest,
	b: RunManifest,
	left: CaseSummary[],
	right: CaseSummary[],
): string {
	const ids = [...new Set([...left, ...right].map((summary) => summary.caseId))].sort();
	const rows = ids.map((id) => {
		const x = left.find((summary) => summary.caseId === id);
		const y = right.find((summary) => summary.caseId === id);
		const rate = (value: CaseSummary | undefined) => (value?.valid ? value.passed / value.valid : 0);
		const delta = (rate(y) - rate(x)) * 100;
		return `| ${id} | ${x ? `${x.passed}/${x.valid}` : "—"} | ${y ? `${y.passed}/${y.valid}` : "—"} | ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}pp | $${(y?.medianCostUsd ?? 0) - (x?.medianCostUsd ?? 0) >= 0 ? "+" : ""}${((y?.medianCostUsd ?? 0) - (x?.medianCostUsd ?? 0)).toFixed(4)} | ${(((y?.medianWallMs ?? 0) - (x?.medianWallMs ?? 0)) / 1_000).toFixed(1)}s |`;
	});
	return `# Eval diff ${leftName} → ${rightName}

Started: ${a.startedAt} → ${b.startedAt}

## Run conditions

| Dimension | A | B | Comparable |
| --- | --- | --- | --- |
${conditionRows(a, b).join("\n")}

## Case deltas

| Case | A | B | Pass Δ | Median cost Δ | Median wall Δ |
| --- | ---: | ---: | ---: | ---: | ---: |
${rows.join("\n")}
`;
}

const invokedAsScript = process.argv[1]?.endsWith("/diff.js") || process.argv[1]?.endsWith("\\diff.js");
if (invokedAsScript) {
	const [leftName, rightName] = process.argv.slice(2);
	if (!leftName || !rightName) throw new Error("Use npm run eval:diff -- <runA> <runB|baseline>.");
	const leftDir = runDir(leftName);
	const rightDir = runDir(rightName);
	process.stdout.write(
		renderDiff(
			leftName,
			rightName,
			read<RunManifest>(leftDir, "manifest.json"),
			read<RunManifest>(rightDir, "manifest.json"),
			read<FrozenSummary>(leftDir, "summary.json").cases,
			read<FrozenSummary>(rightDir, "summary.json").cases,
		),
	);
}
