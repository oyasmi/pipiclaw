import { defineConfig } from "vitest/config";
import { createSuiteHome } from "./test/suite-home.js";

export default defineConfig({
	test: {
		environment: "node",
		globalSetup: ["test/suite-home.ts"],
		setupFiles: ["test/skills-isolation.ts"],
		// paths.ts freezes PIPICLAW_HOME at import time, before a harness can set it; without this
		// default, module-level state (the usage ledger, logs) lands in the developer's real home.
		env: { TZ: "Asia/Shanghai", PIPICLAW_HOME: createSuiteHome() },
		include: ["test/e2e/**/*.test.ts"],
		testTimeout: 120_000,
		// afterAll runs the runtime shutdown, whose memory flush may use its full
		// SHUTDOWN_FLUSH_WAIT_MS (45s) grace period when the real LLM consolidation
		// endpoint is slow. Keep the hook budget above that so a slow-but-legal
		// shutdown flush doesn't spuriously fail the hook.
		hookTimeout: 60_000,
		pool: "forks",
		fileParallelism: false,
		maxConcurrency: 1,
	},
});
