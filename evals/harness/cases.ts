import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allCases } from "../cases/index.js";
import type { EvalCase, ModelGrader } from "./schema.js";
import { hash, hashFile } from "./util.js";

const ID = /^[A-Z]-[a-z0-9-]+-\d{2}$/;

export function validateCases(cases: EvalCase[]): void {
	const ids = new Set<string>();
	for (const item of cases) {
		if (!ID.test(item.id)) throw new Error(`Invalid eval case id '${item.id}'. Use T-name-01 form.`);
		if (ids.has(item.id)) throw new Error(`Duplicate eval case id '${item.id}'.`);
		ids.add(item.id);
		if (item.graders.length + (item.invariants?.length ?? 0) === 0) {
			throw new Error(`${item.id} has no graders. Add a grader before running it.`);
		}
		if (!item.script.length) throw new Error(`${item.id} has no script steps. Add a behavioral interaction.`);
		for (const fixture of item.fixtures ?? []) {
			if (fixture.startsWith("/") || fixture.includes("..")) {
				throw new Error(`${item.id} fixture '${fixture}' must stay below evals/fixtures/.`);
			}
			if (!existsSync(join(process.cwd(), "evals", "fixtures", fixture))) {
				throw new Error(`${item.id} fixture '${fixture}' is missing. Add it or remove the declaration.`);
			}
		}
		if (item.script.some((step) => step.kind === "crash" && step.mode === "midTurn")) {
			for (let index = 0; index < item.script.length; index++) {
				const step = item.script[index];
				if (step?.kind !== "crash" || step.mode !== "midTurn") continue;
				const previous = item.script[index - 1];
				if (previous?.kind !== "user" && previous?.kind !== "syntheticTaskTurn") {
					throw new Error(`${item.id} midTurn crash must immediately follow a user or syntheticTaskTurn step.`);
				}
			}
		}
	}
}

export function selectedCases(): EvalCase[] {
	validateCases(allCases);
	const suite = process.env.EVAL_SUITE;
	const id = process.env.EVAL_CASE;
	if (suite && !["regression", "safety", "capability"].includes(suite)) {
		throw new Error(`Unknown EVAL_SUITE=${suite}. Use regression, safety, or capability.`);
	}
	const cases = allCases.filter((item) => (!suite || item.suite === suite) && (!id || item.id === id));
	if (id && cases.length === 0) throw new Error(`Unknown EVAL_CASE=${id}. Use a case id from evals/cases/.`);
	return cases;
}

export function caseHash(item: EvalCase, root = process.cwd()): string {
	const sourcePath = join(root, item.definitionFile);
	if (!existsSync(sourcePath)) throw new Error(`${item.id} definitionFile does not exist: ${item.definitionFile}`);
	const serialized = JSON.stringify({
		id: item.id,
		suite: item.suite,
		source: item.source,
		description: item.description,
		budget: item.budget,
		steps: item.script.map((step) =>
			step.kind === "waitFor" ? { ...step, predicate: String(step.predicate) } : step,
		),
		graders: [...item.graders, ...(item.invariants ?? [])].map((grader) => ({
			id: grader.graderId,
			version: grader.graderVersion,
			severity: grader.severity,
			rubric: grader.kind === "model" ? grader.rubric : undefined,
			implementation: grader.kind === "model" ? String(grader.artifacts) : String(grader.grade),
		})),
		setup: String(item.setup),
	});
	return hash(
		[
			hashFile(sourcePath),
			hash(serialized),
			...(item.fixtures ?? []).map((fixture) => hashFile(join(root, "evals", "fixtures", fixture))),
		].join("\0"),
	);
}

export function rubricHash(grader: ModelGrader): string {
	return hash(grader.rubric);
}

export function fixtureText(path: string): string {
	return readFileSync(join(process.cwd(), "evals", "fixtures", path), "utf8");
}
