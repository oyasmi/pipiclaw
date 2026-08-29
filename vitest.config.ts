import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Some tests exercise real child processes, Git repositories, fsync-backed writes, and
		// network-shaped timers; keep enough headroom for those operations without disabling
		// timeout protection.
		testTimeout: 30_000,
		// Pinned so local-time formatting/parsing assertions are deterministic regardless of
		// the host running the suite (spec 037: everything time-related is host-local, not UTC).
		env: { TZ: "Asia/Shanghai" },
		include: ["test/**/*.test.ts"],
		// test/e2e runs via `npm run test:e2e`; test/evals holds the behavior-eval toolchain's own
		// regression tests (evals/harness/*, not shipped runtime code) and runs via `test:evals`.
		exclude: ["test/e2e/**/*.test.ts", "test/evals/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			reportsDirectory: "./coverage",
			include: ["src/**/*.ts"],
		},
	},
});
