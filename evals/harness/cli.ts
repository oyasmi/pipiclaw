import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { familyCatalog, metadataForCase } from "../cases/catalog.js";
import { allCases } from "../cases/index.js";
import { validateCases } from "./cases.js";
import { runCycle } from "./cycle.js";
import { renderDiagnostics } from "./diagnostics.js";
import { compareRuns, type Experiment } from "./diff.js";
import { checkOracles, renderOracleChecks } from "./oracle-checks.js";
import { promoteRun } from "./promote.js";
import { regradeRun } from "./regrade.js";
import { rerenderReport } from "./report.js";
import { runMain } from "./run.js";
import type { EvalCase } from "./schema.js";

import { option, profiles, selectCases } from "./selection.js";

function has(args: string[], name: string): boolean {
	return args.includes(name);
}

function metadata(item: EvalCase) {
	return metadataForCase(item.id, item.source, item.description);
}

export function renderList(args: string[]): string {
	validateCases(allCases);
	const { cases } = selectCases(args, true);
	const lines = cases.map((item) => {
		const meta = metadata(item);
		return `${item.id}\t${meta.family}\t${meta.domain}\t${meta.scope}\t${meta.lifecycle}\t${meta.tags.join(",")}\t${meta.owner}`;
	});
	return [
		`ID\tFAMILY\tDOMAIN\tSCOPE\tLIFECYCLE\tTAGS\tOWNER`,
		...lines,
		`\n${cases.length} cases / ${new Set(cases.map((item) => metadata(item).family)).size} families`,
	].join("\n");
}

export function doctor(args: string[], root = process.cwd()): { ok: boolean; output: string } {
	const checks: Array<{ label: string; ok: boolean; detail: string; next?: string }> = [];
	const [major, minor] = process.versions.node.split(".").map(Number);
	checks.push({
		label: "Node",
		ok: major! > 22 || (major === 22 && minor! >= 19),
		detail: process.version,
		next: "Install Node.js >=22.19.0.",
	});
	try {
		validateCases(allCases);
		checks.push({
			label: "case catalog",
			ok: true,
			detail: `${allCases.length} cases / ${familyCatalog.length} families`,
		});
	} catch (error) {
		checks.push({
			label: "case catalog",
			ok: false,
			detail: String(error),
			next: "Repair the named case or migration entry, then rerun doctor.",
		});
	}
	for (const file of ["package-lock.json", "evals/gates.json", "tsconfig.evals.json"]) {
		checks.push({
			label: file,
			ok: existsSync(join(root, file)),
			detail: existsSync(join(root, file)) ? "ready" : "missing",
			next: `Restore ${file}.`,
		});
	}
	const localHome = join(homedir(), ".pipiclaw");
	for (const file of ["settings.json", "models.json", "auth.json"]) {
		const present = existsSync(join(localHome, file));
		checks.push({
			label: `local ${file}`,
			ok: present,
			detail: present ? "present" : "missing",
			next: `Configure ~/.pipiclaw/${file} or use an explicit CI profile.`,
		});
	}
	if (has(args, "--probe"))
		checks.push({
			label: "model probe",
			ok: false,
			detail: "not sent by doctor",
			next: "Run one explicit dev trial to test provider connectivity: npm run eval -- run --profile dev --case <id>.",
		});
	const ok = checks.every((check) => check.ok);
	return {
		ok,
		output: checks
			.map(
				(check) =>
					`${check.ok ? "PASS" : "FAIL"}\t${check.label}\t${check.detail}${check.ok || !check.next ? "" : `\n  Next: ${check.next}`}`,
			)
			.join("\n"),
	};
}

export function renderPlan(args: string[]): string {
	validateCases(allCases);
	const selection = selectCases(args);
	const { profile: profileName, trials } = selection;
	const total = selection.cases.length * trials;
	const maxCost = selection.cases.reduce((sum, item) => sum + (item.budget?.maxCostUsd ?? 0.5) * trials, 0);
	const maxWall = selection.cases.reduce((sum, item) => sum + (item.budget?.maxWallMs ?? 180_000) * trials, 0);
	const familyCount = new Set(selection.cases.map((item) => metadata(item).family)).size;
	const executionArgs = args.filter(
		(arg, index) =>
			!["--trials", "--concurrency", "--judge-concurrency"].includes(arg) &&
			!["--trials", "--concurrency", "--judge-concurrency"].includes(args[index - 1] ?? ""),
	);
	if (!executionArgs.includes("--profile")) executionArgs.push("--profile", profileName);
	executionArgs.push(
		"--trials",
		String(trials),
		"--concurrency",
		String(selection.concurrency),
		"--judge-concurrency",
		String(selection.judgeConcurrency),
	);
	if (!executionArgs.includes("--judge")) executionArgs.push("--judge", selection.judgeEnabled ? "advisory" : "off");
	const command = executionArgs
		.map((arg) => (/^[A-Za-z0-9_./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
		.join(" ");

	return [
		`Eval plan (read-only; 未调用模型)`,
		`profile: ${profileName} — ${profiles[profileName].description}`,
		`coverage: ${selection.cases.length} cases / ${familyCount} families; ${total} trials`,
		`resource ceiling: $${maxCost.toFixed(2)} agent cost; ${(maxWall / 60_000).toFixed(1)} serial minutes (upper bound, not ETA)`,
		`concurrency: ${selection.concurrency} agent / ${selection.judgeConcurrency} judge`,
		`model judging: ${selection.judgeEnabled ? selection.cases.reduce((sum, item) => sum + [...item.graders, ...(item.invariants ?? [])].filter((grader) => grader.kind === "model").length * trials, 0) : 0} advisory decisions; judge spend is separate from the agent ceiling`,
		`confidence: ${profiles[profileName].mode === "smoke" ? "smoke only; never a release or baseline decision" : trials === 1 ? "smoke only" : trials < 10 ? "candidate signal; not a release conclusion" : "decision sample; still inspect intervals and paired completeness"}`,
		...selection.cases.map(
			(item) =>
				`${item.id} x${trials}\t${selection.reasons[item.id]?.join("; ")}\t${metadata(item).contract.objective}`,
		),
		`Run: npm run eval -- run ${command}`,
	].join("\n");
}

function usage(): string {
	return `Usage:\n  npm run eval -- cycle [selection] [--max-cost-usd 25] [--max-wall-minutes 180] [--experiment none|runtime|model]\n  npm run eval -- list [--domain memory|--family ID|--tag core]\n  npm run eval -- selftest [selection]\n  npm run eval -- doctor\n  npm run eval -- plan [--changed-since REF|--case ID|--family ID] [--profile dev|core|candidate|explore|external]\n  npm run eval -- run [selection|--all] [--trials N] [--concurrency N] [--judge-concurrency N]\n  npm run eval -- report <runId> [--verbose]\n  npm run eval -- resume <runId>\n  npm run eval -- regrade <runId> [--grader ID]\n  npm run eval -- diagnose <runId>\n  npm run eval -- compare <runA> <runB|baseline> --experiment none|runtime|model\n  npm run eval -- baseline promote <runId>`;
}

export function setSelectedCasesEnvironment(caseIds: string[], env: NodeJS.ProcessEnv = process.env): void {
	delete env.EVAL_SUITE;
	if (caseIds.length === 1) {
		env.EVAL_CASE = caseIds[0];
		delete env.EVAL_CASES;
	} else {
		delete env.EVAL_CASE;
		env.EVAL_CASES = caseIds.join(",");
	}
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const command = args[0];
	if (!command) return void process.stdout.write(`${renderPlan([])}\n`);
	if (command === "help" || command === "--help") return void process.stdout.write(`${usage()}\n`);
	if (command === "cycle") return runCycle(args.slice(1), setSelectedCasesEnvironment);
	if (command === "list") return void process.stdout.write(`${renderList(args.slice(1))}\n`);
	if (command === "doctor") {
		const result = doctor(args.slice(1));
		process.stdout.write(`${result.output}\n`);
		if (!result.ok) process.exitCode = 2;
		return;
	}
	if (command === "selftest") {
		const selection = selectCases(args.slice(1));
		const evidenceDir = join(process.cwd(), "evals/results", `selftest-${Date.now()}`);
		const results = await checkOracles(selection.cases, evidenceDir);
		process.stdout.write(`${renderOracleChecks(results)}\nEvidence: ${evidenceDir}/oracle-checks.json\n`);
		if (Object.values(results).some((result) => result.status !== "qualified")) process.exitCode = 2;
		return;
	}
	if (command === "plan") return void process.stdout.write(`${renderPlan(args.slice(1))}\n`);
	if (command === "report") {
		if (!args[1]) throw new Error("Use npm run eval -- report <runId> [--verbose].");
		const result = rerenderReport(process.cwd(), args[1]);
		return void process.stdout.write(readFileSync(has(args, "--verbose") ? result.detailsPath : result.path, "utf8"));
	}
	if (command === "diagnose") {
		if (!args[1]) throw new Error("Use npm run eval -- diagnose <runId>.");
		return void process.stdout.write(`${renderDiagnostics(process.cwd(), args[1])}\n`);
	}
	if (command === "compare") {
		const left = args[1];
		const right = args[2];
		const experiment = (option(args, "--experiment") ?? "none") as Experiment;
		if (!left || !right || !["none", "runtime", "model"].includes(experiment))
			throw new Error("Use npm run eval -- compare <runA> <runB|baseline> --experiment none|runtime|model.");
		return void process.stdout.write(compareRuns(process.cwd(), left, right, experiment));
	}
	if (command === "regrade") {
		const runId = args[1];
		const graderId = option(args, "--grader");
		if (!runId) throw new Error("Use npm run eval -- regrade <runId> [--grader ID].");
		return void process.stdout.write(`${await regradeRun(process.cwd(), runId, { graderId })}\n`);
	}
	if (command === "baseline") {
		if (args[1] !== "promote" || !args[2]) throw new Error("Use npm run eval -- baseline promote <runId>.");
		return void process.stdout.write(`Promoted ${args[2]} to ${promoteRun(process.cwd(), args[2])}.\n`);
	}
	if (command === "resume") {
		await runMain(["--resume", args[1] ?? ""]);
		return;
	}
	if (command === "run") {
		const selection = selectCases(args.slice(1));
		setSelectedCasesEnvironment(
			selection.cases.map((item) => item.id),
			process.env,
		);
		delete process.env.EVAL_RESUME;
		process.env.EVAL_TRIALS = String(selection.trials);
		process.env.EVAL_CONCURRENCY = String(selection.concurrency);
		process.env.EVAL_JUDGE_CONCURRENCY = String(selection.judgeConcurrency);
		await runMain([], {
			profile: selection.profile,
			reasons: selection.reasons,
			judgeEnabled: selection.judgeEnabled,
		});
		return;
	}
	throw new Error(`Unknown eval command '${command}'.\n${usage()}`);
}

const invokedAsScript = process.argv[1]?.endsWith("/cli.js") || process.argv[1]?.endsWith("\\cli.js");
if (invokedAsScript) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	});
}
