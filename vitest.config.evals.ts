import { defineConfig } from "vitest/config";

// Regression tests for the behavior-eval toolchain itself (evals/harness/*). These test
// developer CI tooling, not shipped runtime code, so they live outside `npm run test`
// and run via `npm run test:evals`.
export default defineConfig({
	test: {
		environment: "node",
		env: { TZ: "Asia/Shanghai" },
		include: ["test/evals/**/*.test.ts"],
		// runWorkerSegment spawns real child processes and asserts SIGTERM hard-stop timing.
		testTimeout: 30_000,
	},
});
