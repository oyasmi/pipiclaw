import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";

function run(stage, args) {
	const start = performance.now();
	const result = spawnSync(process.execPath, args, { stdio: "inherit" });
	const duration = ((performance.now() - start) / 1000).toFixed(1);
	if (result.status === 0) {
		console.log(`E2E ${stage} passed in ${duration}s`);
		return true;
	}
	console.error(`E2E ${stage} failed after ${duration}s (${result.error?.message ?? result.signal ?? result.status})`);
	process.exitCode = result.status ?? 1;
	return false;
}

const require = createRequire(import.meta.url);
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run the deterministic suite with npm run test:e2e.");

if (run("build", [npm, "run", "build"])) {
	const manifest = require.resolve("vitest/package.json");
	run("tests", [
		resolve(dirname(manifest), require(manifest).bin.vitest),
		"run",
		"--config",
		"vitest.config.e2e.ts",
		"--dir",
		"test/e2e/deterministic",
		"--fileParallelism",
		"--maxWorkers=2",
		...process.argv.slice(2),
	]);
}
