import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oracleControls } from "../controls/catalog.js";
import { buildPositiveContext } from "../controls/fixtures.js";
import { atomicJson } from "./artifacts.js";
import { caseHash } from "./cases.js";
import { trialSeed } from "./fixture-seed.js";
import { evalDotDir } from "./layout.js";
import type { EvalCase, GradeResult, OracleCheckSummary, TrialContext } from "./schema.js";
import { gradeTrial } from "./scoring.js";
import { hash, hashFile } from "./util.js";

export interface OracleCheckResult extends OracleCheckSummary {
	caseId: string;
	checks: Array<{
		id: string;
		risk: string;
		expected: "pass" | "reject";
		targets?: string[];
		passed: boolean;
		grades: GradeResult[];
		error?: string;
	}>;
}

export function oracleFingerprint(item: EvalCase, root = process.cwd()): string {
	const files = [
		"evals/controls/catalog.ts",
		"evals/controls/fixtures.ts",
		"evals/controls/types.ts",
		"evals/harness/oracle-checks.ts",
	];
	return hash(
		JSON.stringify({
			case: caseHash(item, root),
			controls: files.map((file) =>
				existsSync(join(root, file)) ? [file, hashFile(join(root, file))] : [file, "missing"],
			),
		}),
	);
}

function context(homeDir: string): TrialContext {
	const workspaceDir = join(homeDir, "workspace");
	const dotDir = evalDotDir(workspaceDir);
	mkdirSync(dotDir, { recursive: true });
	return {
		homeDir,
		workspaceDir,
		dotDir,
		trace: [],
		deliveries: [],
		snapshot: {
			schemaVersion: 1,
			deliveries: [],
			fileTree: [],
			canaries: [{ path: "controlled-canary.txt", intact: true }],
			externalRequests: [],
		},
	};
}

/** Offline certification of explicitly declared counterexamples; never calls an agent or judge. */
export async function checkOracle(item: EvalCase, root = process.cwd()): Promise<OracleCheckResult> {
	const controls = oracleControls(item.id);
	const fingerprint = oracleFingerprint(item, root);
	if (
		!controls ||
		!item.graders.some((grader) => grader.kind !== "model" && grader.severity !== "hard-invariant") ||
		[...item.graders, ...(item.invariants ?? [])].some(
			(grader) => grader.kind === "model" && grader.severity === "hard-invariant",
		)
	)
		return {
			caseId: item.id,
			status: "uncovered",
			fingerprint,
			positive: 0,
			negative: 0,
			passed: 0,
			total: 0,
			checks: [],
		};
	const checks: OracleCheckResult["checks"] = [];
	for (const control of controls) {
		const home = mkdtempSync(join(tmpdir(), "pipiclaw-oracle-"));
		try {
			let ctx = context(home);
			ctx.seed = trialSeed(item.id, control.seedTrial ?? 1);
			if (control.from !== "empty") ctx = buildPositiveContext(item.id, ctx);
			await control.apply(ctx);
			const grades = (
				await gradeTrial(item, ctx, "completed", async () => {
					throw new Error("Offline oracle checks must not call a model");
				})
			).filter((grade) => grade.graderKind !== "model");
			const allComplete =
				grades.length > 0 && grades.every((grade) => grade.status === "pass" || grade.status === "fail");
			const passed =
				control.expect === "pass"
					? allComplete && grades.every((grade) => grade.status === "pass")
					: grades.some(
							(grade) =>
								grade.status === "fail" && (!control.targets || control.targets.includes(grade.graderId)),
						);
			checks.push({
				id: control.id,
				risk: control.risk,
				expected: control.expect,
				targets: control.targets,
				passed,
				grades,
			});
		} catch (error) {
			checks.push({
				id: control.id,
				risk: control.risk,
				expected: control.expect,
				targets: control.targets,
				passed: false,
				grades: [],
				error: String(error),
			});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}
	return {
		caseId: item.id,
		status: checks.every((check) => check.passed) ? "qualified" : "failed",
		fingerprint,
		positive: controls.filter((control) => control.expect === "pass").length,
		negative: controls.filter((control) => control.expect === "reject").length,
		passed: checks.filter((check) => check.passed).length,
		total: checks.length,
		checks,
	};
}

export async function checkOracles(cases: EvalCase[], outputDir?: string): Promise<Record<string, OracleCheckSummary>> {
	const results: OracleCheckResult[] = [];
	for (const item of cases) results.push(await checkOracle(item));
	if (outputDir) {
		mkdirSync(outputDir, { recursive: true });
		atomicJson(join(outputDir, "oracle-checks.json"), { schemaVersion: 1, modelRequests: 0, results });
	}
	return Object.fromEntries(results.map(({ caseId, checks: _checks, ...summary }) => [caseId, summary]));
}

export function renderOracleChecks(results: Record<string, OracleCheckSummary>): string {
	const values = Object.values(results);
	return [
		"Oracle self-check (offline; 0 model requests)",
		...Object.entries(results).map(
			([id, result]) =>
				`${result.status.toUpperCase()} ${id}: ${result.passed}/${result.total} controls (${result.positive} valid / ${result.negative} invalid completions)`,
		),
		`${values.filter((value) => value.status === "qualified").length}/${values.length} cases qualified. Qualification covers declared counterexamples, not all possible failures.`,
	].join("\n");
}
