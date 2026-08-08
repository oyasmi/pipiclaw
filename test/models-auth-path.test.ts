import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.PIPICLAW_HOME;
const originalOffline = process.env.PI_OFFLINE;

let home: string;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

async function loadPaths() {
	vi.resetModules();
	return import("../src/paths.js");
}

describe("auth.json path guardrails (spec 039 §4.2)", () => {
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "auth-path-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		restoreEnv("PIPICLAW_HOME", originalHome);
		restoreEnv("PI_OFFLINE", originalOffline);
	});

	it("places AUTH_CONFIG_PATH under the default app home", async () => {
		delete process.env.PIPICLAW_HOME;
		const paths = await loadPaths();
		expect(paths.AUTH_CONFIG_PATH).toBe(join(paths.DEFAULT_APP_HOME_DIR, "auth.json"));
	});

	it("moves AUTH_CONFIG_PATH when PIPICLAW_HOME is set", async () => {
		process.env.PIPICLAW_HOME = home;
		const paths = await loadPaths();
		expect(paths.AUTH_CONFIG_PATH).toBe(join(home, "auth.json"));
		expect(paths.AUTH_CONFIG_PATH.startsWith(home)).toBe(true);
	});

	it("createModelRuntime rejects a missing authConfigPath", async () => {
		const { createModelRuntime } = await import("../src/models/utils.js");
		await expect(
			createModelRuntime({ authConfigPath: "", modelsConfigPath: join(home, "models.json") }),
		).rejects.toThrow(/absolute path/);
	}, 20_000);

	it("createModelRuntime rejects a relative authConfigPath", async () => {
		const { createModelRuntime } = await import("../src/models/utils.js");
		await expect(
			createModelRuntime({ authConfigPath: "auth.json", modelsConfigPath: join(home, "models.json") }),
		).rejects.toThrow(/absolute path/);
	}, 20_000);

	it("login orchestration writes to the configured authConfigPath, not ~/.pi/agent/auth.json", async () => {
		process.env.PIPICLAW_HOME = home;
		// ModelRuntime.login() refreshes the model catalog from pi.dev with no timeout of its own;
		// force offline so this test's outcome depends on file writes, not live network latency.
		process.env.PI_OFFLINE = "1";
		const paths = await loadPaths();
		const { createModelRuntime } = await import("../src/models/utils.js");
		const { loginProvider } = await import("../src/models/provider-login.js");

		const runtime = await createModelRuntime({
			authConfigPath: paths.AUTH_CONFIG_PATH,
			modelsConfigPath: paths.MODELS_CONFIG_PATH,
		});

		const controller = new AbortController();
		await loginProvider(runtime, "anthropic", "api_key", {
			signal: controller.signal,
			ask: async () => "sk-test-key",
			notify: () => {},
		});

		expect(existsSync(paths.AUTH_CONFIG_PATH)).toBe(true);
		const written = JSON.parse(readFileSync(paths.AUTH_CONFIG_PATH, "utf-8"));
		expect(written.anthropic).toMatchObject({ type: "api_key", key: "sk-test-key" });
	});
});
