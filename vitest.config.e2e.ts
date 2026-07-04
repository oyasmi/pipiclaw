import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
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
