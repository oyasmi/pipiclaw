import { defineConfig } from "vitest/config";
import { createSuiteHome } from "./test/suite-home.js";

// Regression tests for the behavior-eval toolchain itself (evals/harness/*). These test
// developer CI tooling, not shipped runtime code, so they live outside `npm run test`
// and run via `npm run test:evals`.
export default defineConfig({
	test: {
		environment: "node",
		globalSetup: ["test/suite-home.ts"],
		env: { TZ: "Asia/Shanghai", PIPICLAW_HOME: createSuiteHome() },
		include: ["test/evals/**/*.test.ts"],
		// runWorkerSegment spawns real child processes and asserts SIGTERM hard-stop timing.
		testTimeout: 30_000,
	},
});
