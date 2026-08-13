import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		// Passing runtime tests emit a large amount of expected operational logging. Keep that
		// noise out of local/CI output while preserving stdout/stderr for failures.
		silent: "passed-only",
		// Pinned so local-time formatting/parsing assertions are deterministic regardless of
		// the host running the suite (spec 037: everything time-related is host-local, not UTC).
		env: { TZ: "Asia/Shanghai" },
		include: ["test/**/*.test.ts"],
		exclude: ["test/e2e/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary", "html"],
			reportsDirectory: "./coverage",
			include: ["src/**/*.ts"],
		},
	},
});
