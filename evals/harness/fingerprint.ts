import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import type { EvalCase } from "./schema.js";
import { hash, hashFile } from "./util.js";

/** Stable object-key order; array order remains meaningful. */
export function canonicalJson(value: unknown): string {
	const canonical = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(canonical);
		if (input && typeof input === "object")
			return Object.fromEntries(
				Object.entries(input)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, child]) => [key, canonical(child)]),
			);
		return input;
	};
	return JSON.stringify(canonical(value));
}

/** Normalize only known mount roots, preserving actual security and endpoint differences. */
export function canonicalConfigHash(value: unknown, mounts: Record<string, string>): string {
	const roots = Object.entries(mounts)
		.filter(([root]) => root.length > 0)
		.sort(([a], [b]) => b.length - a.length);
	const normalize = (input: unknown): unknown => {
		if (typeof input === "string") {
			let output = input;
			for (const [root, token] of roots) output = output.split(root).join(token);
			return output;
		}
		if (Array.isArray(input)) return input.map(normalize);
		if (input && typeof input === "object")
			return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, normalize(child)]));
		return input;
	};
	return hash(canonicalJson(normalize(value)));
}

/**
 * Legacy closures have no serializable environment. Conservatively hash their case module
 * and imported evaluator modules until migrated to fully declarative fixtures. This can
 * invalidate sibling cases, but can never silently compare changed captured constants.
 * Imported production helpers are evaluator dependencies too. Unrelated runtime code
 * remains an experimental variable. Extra data dependencies must be declared explicitly.
 */
export function caseDependencyHashes(item: EvalCase, root = process.cwd()): Record<string, string> {
	const found = new Map<string, string>();
	const visit = (file: string): void => {
		const absolute = resolve(root, file);
		const name = relative(root, absolute).split("\\").join("/");
		if (name.startsWith("../") || !existsSync(absolute))
			throw new Error(`Missing or unconfined eval dependency ${file}; repair the case declaration.`);
		if (found.has(name)) return;
		found.set(name, hashFile(absolute));
		if ((!name.startsWith("evals/") && !name.startsWith("src/")) || !name.endsWith(".ts")) return;
		for (const imported of ts.preProcessFile(readFileSync(absolute, "utf8")).importedFiles) {
			if (!imported.fileName.startsWith(".")) continue;
			const target = resolve(dirname(absolute), imported.fileName.replace(/\.js$/, ".ts"));
			const dependency = relative(root, target).split("\\").join("/");
			if (dependency.startsWith("evals/") || dependency.startsWith("src/")) visit(target);
		}
	};
	visit(item.definitionFile);
	for (const file of item.dependencies ?? []) visit(file);
	// These helpers participate even when a custom case imports them via a wrapper.
	for (const file of [
		"evals/harness/graders.ts",
		"evals/harness/scoring.ts",
		"evals/harness/fingerprint.ts",
		"evals/harness/cases.ts",
		"evals/harness/judge.ts",
	]) {
		if (existsSync(join(root, file))) found.set(file, hashFile(join(root, file)));
	}
	return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));
}
