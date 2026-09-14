// Local hygiene tool, not part of `npm run check`: `evals/results/` and `evals/baselines/`
// (both gitignored — see spec-050-style CLAUDE.md rule "don't track what's already on disk") grow
// one directory per eval run with no built-in retention, and a personal-project machine has no
// ops team pruning it. Keeps the most recent `--keep` run directories per root (sorted by their
// ISO-timestamp prefix, so lexical order is chronological order) and reports what it would delete
// unless `--yes` is passed. `evals/baselines/latest.json` names a run that must never be pruned
// even if it has aged out of the keep window — deleting the active baseline out from under
// `npm run eval:diff` would silently break comparisons.
//
// Usage: node scripts/prune-eval-results.mjs [--keep=10] [--baselines-keep=3] [--yes]
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function parseArgs(argv) {
	const args = { keep: 10, baselinesKeep: 3, yes: false };
	for (const arg of argv) {
		if (arg === "--yes") args.yes = true;
		else if (arg.startsWith("--keep=")) args.keep = Number(arg.slice("--keep=".length));
		else if (arg.startsWith("--baselines-keep=")) args.baselinesKeep = Number(arg.slice("--baselines-keep=".length));
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

/** Run directories are named `<ISO timestamp>-<random>`, so lexical sort is chronological. */
function listRunDirs(dir) {
	try {
		return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

function pruneDir(label, dir, keep, protect, yes) {
	const names = listRunDirs(dir).sort();
	const toDelete = names.slice(0, Math.max(0, names.length - keep)).filter((name) => !protect.has(name));
	if (toDelete.length === 0) {
		console.log(`${label}: ${names.length} run(s), nothing to prune (keeping ${keep}).`);
		return;
	}
	console.log(`${label}: ${names.length} run(s), pruning ${toDelete.length} (keeping the ${keep} most recent):`);
	for (const name of toDelete) console.log(`  - ${name}`);
	if (!yes) {
		console.log(`  (dry run — pass --yes to actually delete)`);
		return;
	}
	for (const name of toDelete) rmSync(join(dir, name), { recursive: true, force: true });
	console.log(`  deleted ${toDelete.length} director${toDelete.length === 1 ? "y" : "ies"}.`);
}

function readActiveBaseline(baselinesDir) {
	try {
		const latest = JSON.parse(readFileSync(join(baselinesDir, "latest.json"), "utf-8"));
		return typeof latest.runId === "string" ? latest.runId : undefined;
	} catch {
		return undefined;
	}
}

const args = parseArgs(process.argv.slice(2));
const resultsDir = join(ROOT, "evals/results");
const baselinesDir = join(ROOT, "evals/baselines");
const activeBaseline = readActiveBaseline(baselinesDir);

pruneDir("evals/results", resultsDir, args.keep, new Set(), args.yes);
pruneDir(
	"evals/baselines",
	baselinesDir,
	args.baselinesKeep,
	new Set(activeBaseline ? [activeBaseline] : []),
	args.yes,
);
