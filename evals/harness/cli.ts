import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { coreRepresentativeIds, familyCatalog, metadataForCase } from "../cases/catalog.js";
import { allCases } from "../cases/index.js";
import { validateCases } from "./cases.js";
import { compareRuns, type Experiment } from "./diff.js";
import { promoteRun } from "./promote.js";
import { regradeRun } from "./regrade.js";
import { runMain } from "./run.js";
import type { EvalCase, EvalDomain, HumanReviewRecord, TrialRecord } from "./schema.js";

type ProfileName = "dev" | "core" | "candidate" | "explore" | "external";
const profiles: Record<ProfileName, { trials: number; description: string }> = {
	dev: { trials: 1, description: "相关场景快速检查" },
	core: { trials: 3, description: "12 个核心家族的日常回归" },
	candidate: { trials: 10, description: "同条件版本决策" },
	explore: { trials: 1, description: "困难变体探索，report-only" },
	external: { trials: 1, description: "真实外部执行器 smoke" },
};

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function has(args: string[], name: string): boolean {
	return args.includes(name);
}

function metadata(item: EvalCase) {
	return metadataForCase(item.id, item.source, item.description);
}

function selected(args: string[]): { cases: EvalCase[]; reasons: Record<string, string[]> } {
	const reasons: Record<string, string[]> = {};
	const caseId = option(args, "--case");
	const family = option(args, "--family");
	const domain = option(args, "--domain") as EvalDomain | undefined;
	const lifecycle = option(args, "--lifecycle");
	const tag = option(args, "--tag");
	const scope = option(args, "--scope");
	const profile = (option(args, "--profile") ?? "dev") as ProfileName;
	if (!profiles[profile]) throw new Error(`Unknown profile '${profile}'; use ${Object.keys(profiles).join(", ")}.`);
	let cases = allCases.filter((item) => {
		const meta = metadata(item);
		const matches =
			(!caseId || item.id === caseId) &&
			(!family || meta.family === family) &&
			(!domain || meta.domain === domain) &&
			(!lifecycle || meta.lifecycle === lifecycle) &&
			(!tag || meta.tags.includes(tag)) &&
			(!scope || meta.scope === scope);
		if (matches)
			reasons[item.id] = [
				caseId
					? `case=${caseId}`
					: family
						? `family=${family}`
						: domain
							? `domain=${domain}`
							: `profile=${profile}`,
			];
		return matches;
	});
	const changedSince = option(args, "--changed-since");
	if (changedSince) {
		const result = spawnSync("git", ["diff", "--name-only", changedSince], { encoding: "utf8" });
		if (result.status !== 0)
			throw new Error(`Cannot diff ${changedSince}; fetch the ref or pass an existing commit.`);
		const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
		const files = [...new Set(`${result.stdout}\n${untracked.stdout}`.split("\n").filter(Boolean))];
		const common = files.some((file) =>
			/^(src\/agent\/prompt|src\/tools|evals\/harness\/schema|evals\/harness\/worker)/.test(file),
		);
		cases = cases.filter((item) => {
			const meta = metadata(item);
			const dependencyRoots = familyCatalog.find((family) => family.id === meta.family)?.dependencies ?? [];
			const domainHit = files.some((file) =>
				dependencyRoots.some((pattern) => file.startsWith(pattern.replace(/\/\*\*$/, ""))),
			);
			const direct = files.some((file) => item.definitionFile === file || (item.dependencies ?? []).includes(file));
			if (common || domainHit || direct) {
				reasons[item.id] = [
					`changed-since=${changedSince}`,
					common ? "公共 prompt/tool/runtime 依赖" : direct ? "case 直接依赖" : `domain=${meta.domain}`,
				];
				return true;
			}
			return false;
		});
		if (!cases.length && files.length) {
			cases = allCases.filter((item) => metadata(item).tags.includes("core"));
			for (const item of cases) reasons[item.id] = [`changed-since=${changedSince}`, "变更无法可靠归因，回退 core"];
		}
	}
	if (!caseId && !family && !domain && !lifecycle && !tag && !scope && !changedSince) {
		if (profile === "core" || profile === "candidate")
			cases = cases.filter((item) => (coreRepresentativeIds as readonly string[]).includes(item.id));
		if (profile === "explore") cases = cases.filter((item) => metadata(item).tags.includes("extended"));
		if (profile === "external") cases = cases.filter((item) => metadata(item).family === "D-external-01");
	}
	if (!cases.length) throw new Error("No eval cases matched; run `npm run eval -- list` and adjust the filters.");
	return { cases, reasons };
}

export function renderList(args: string[]): string {
	validateCases(allCases);
	const { cases } = selected(args);
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
	const major = Number(process.versions.node.split(".")[0]);
	checks.push({ label: "Node", ok: major >= 22, detail: process.version, next: "Install Node.js >=22.19.0." });
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
					`${check.ok ? "PASS" : "FAIL"}\t${check.label}\t${check.detail}${check.ok || !check.next ? "" : `\n  下一步：${check.next}`}`,
			)
			.join("\n"),
	};
}

export function renderPlan(args: string[]): string {
	validateCases(allCases);
	const profileName = (option(args, "--profile") ?? "dev") as ProfileName;
	if (!profiles[profileName]) throw new Error(`Unknown profile '${profileName}'.`);
	const selection = selected(args);
	const trialsOverride = Number(option(args, "--trials") ?? "");
	const trials =
		Number.isInteger(trialsOverride) && trialsOverride > 0 ? trialsOverride : profiles[profileName].trials;
	const total = selection.cases.length * trials;
	const maxCost = selection.cases.reduce((sum, item) => sum + (item.budget?.maxCostUsd ?? 0.5) * trials, 0);
	const maxWall = selection.cases.reduce((sum, item) => sum + (item.budget?.maxWallMs ?? 180_000) * trials, 0);
	const familyCount = new Set(selection.cases.map((item) => metadata(item).family)).size;
	return [
		`评测计划（只读，未调用模型）`,
		`profile: ${profileName} — ${profiles[profileName].description}`,
		`coverage: ${selection.cases.length} cases / ${familyCount} families; ${total} trials`,
		`resource ceiling: $${maxCost.toFixed(2)} agent cost; ${(maxWall / 60_000).toFixed(1)} serial minutes`,
		`confidence: ${trials === 1 ? "smoke only" : trials < 10 ? "candidate signal; not a release conclusion" : "decision sample; still inspect intervals and paired completeness"}`,
		...selection.cases.map(
			(item) =>
				`${item.id} x${trials}\t${selection.reasons[item.id]?.join("; ")}\t${metadata(item).contract.objective}`,
		),
		`执行：npm run eval -- run --profile ${profileName}${selection.cases.length === 1 ? ` --case ${selection.cases[0]!.id}` : ""}${trialsOverride ? ` --trials ${trials}` : ""}`,
	].join("\n");
}

function findRun(root: string, runId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Invalid run id; use the id printed by eval.");
	const dir = ["results", "baselines"].map((parent) => join(root, "evals", parent, runId)).find(existsSync);
	if (!dir) throw new Error(`Run ${runId} was not found; use an id below evals/results or evals/baselines.`);
	return dir;
}

export function renderReview(root: string, runId: string): string {
	const dir = findRun(root, runId);
	const records = readFileSync(join(dir, "trials.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as TrialRecord);
	const failures = records.filter((record) => record.outcome !== "pass");
	if (!failures.length)
		return `Run ${runId}: no failed trials. Review queued model grades in ${relative(root, join(dir, "human-review-sample.json"))}.`;
	return failures
		.map((record) => {
			const grade = record.grades.find((entry) => entry.status === "fail" || entry.status === "error");
			const stop = record.result?.stopReason;
			const trialDir = join(dir, "trials", `${record.caseId}-${record.trial}`);
			return [
				`${record.caseId}#${record.trial} ${record.result?.execution ?? record.outcome}`,
				stop
					? `  停止原因：${stop.source}/${stop.code} — evidenceComplete=${record.result?.evidenceComplete ?? false}`
					: `  首次判定：${grade?.graderId ?? "unknown"} — ${grade?.rationale ?? "inspect trial record"}`,
				`  证据：${stop?.evidenceId ?? grade?.evidence.map((entry) => entry.ref).join(", ") ?? "record.json"}`,
				`  复现：npm run eval -- run --case ${record.caseId} --trials 1 --profile dev`,
				`  路径：${relative(root, trialDir)}`,
			].join("\n");
		})
		.join("\n\n");
}

function recordReview(args: string[], root: string): string {
	const runId = args[0];
	if (!runId) throw new Error("review record requires a run id.");
	const dir = findRun(root, runId);
	const caseId = option(args, "--case");
	const graderId = option(args, "--grader");
	const verdict = option(args, "--verdict") as HumanReviewRecord["verdict"] | undefined;
	const reviewer = option(args, "--reviewer");
	const note = option(args, "--note");
	const cohort = (option(args, "--cohort") ?? "holdout") as HumanReviewRecord["cohort"];
	const trial = Number(option(args, "--trial"));
	if (
		!caseId ||
		!graderId ||
		!reviewer ||
		!note ||
		!Number.isInteger(trial) ||
		!["development", "holdout"].includes(cohort ?? "") ||
		!["agree", "overturn-to-pass", "overturn-to-fail"].includes(verdict ?? "")
	)
		throw new Error(
			"Use review record <runId> --case <id> --trial <n> --grader <id> --verdict agree|overturn-to-pass|overturn-to-fail --reviewer <name> --cohort development|holdout --note <text>.",
		);
	const value: HumanReviewRecord = {
		schemaVersion: 1,
		caseId,
		trial,
		graderId,
		cohort,
		verdict: verdict!,
		reviewer,
		note,
		ts: new Date().toISOString(),
	};
	appendFileSync(join(dir, "human-review.jsonl"), `${JSON.stringify(value)}\n`);
	return `Recorded ${caseId}#${trial}/${graderId}; run npm run eval:report -- ${runId} to refresh calibration.`;
}

function usage(): string {
	return `Usage:\n  npm run eval -- list [--domain memory|--family ID|--tag core]\n  npm run eval -- doctor [--profile local]\n  npm run eval -- plan [--changed-since REF|--case ID|--family ID] [--profile dev|core|candidate|explore|external]\n  npm run eval -- run [selection] [--trials N]\n  npm run eval -- resume <runId>\n  npm run eval -- regrade <runId> [--grader ID]\n  npm run eval -- review <runId>\n  npm run eval -- review record <runId> ...\n  npm run eval -- compare <runA> <runB|baseline> --experiment none|runtime|model\n  npm run eval -- baseline promote <runId>`;
}

export function setSelectedCasesEnvironment(caseIds: string[], env: NodeJS.ProcessEnv = process.env): void {
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
	if (!command || command === "help" || command === "--help") return void process.stdout.write(`${usage()}\n`);
	if (command === "list") return void process.stdout.write(`${renderList(args.slice(1))}\n`);
	if (command === "doctor") {
		const result = doctor(args.slice(1));
		process.stdout.write(`${result.output}\n`);
		if (!result.ok) process.exitCode = 2;
		return;
	}
	if (command === "plan") return void process.stdout.write(`${renderPlan(args.slice(1))}\n`);
	if (command === "review") {
		if (args[1] === "record") return void process.stdout.write(`${recordReview(args.slice(2), process.cwd())}\n`);
		if (!args[1]) throw new Error("Use npm run eval -- review <runId>.");
		return void process.stdout.write(`${renderReview(process.cwd(), args[1])}\n`);
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
	if (command === "resume") return runMain(["--resume", args[1] ?? ""]);
	if (command === "run") {
		const selection = selected(args.slice(1));
		setSelectedCasesEnvironment(
			selection.cases.map((item) => item.id),
			process.env,
		);
		const trials =
			option(args, "--trials") ?? String(profiles[(option(args, "--profile") ?? "dev") as ProfileName].trials);
		process.env.EVAL_TRIALS = trials;
		return runMain([]);
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
