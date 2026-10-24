import { join } from "path";
import { vi } from "vitest";
import type { AgentRunner } from "../../src/agent/types.js";
import type { BootstrapPaths } from "../../src/app/home.js";
import { createFakeSessionBinding, createFakeTurnState } from "../helpers/fake-turn-state.js";

/** App-home paths under `appHomeDir`, the layout every runtime-level unit test boots against. */
export function bootstrapPathsIn(appHomeDir: string): BootstrapPaths {
	return {
		appName: "pipiclaw",
		appHomeDir,
		workspaceDir: join(appHomeDir, "workspace"),
		authConfigPath: join(appHomeDir, "auth.json"),
		channelConfigPath: join(appHomeDir, "channel.json"),
		modelsConfigPath: join(appHomeDir, "models.json"),
		settingsConfigPath: join(appHomeDir, "settings.json"),
		toolsConfigPath: join(appHomeDir, "tools.json"),
		securityConfigPath: join(appHomeDir, "security.json"),
		eventHistoryPath: join(appHomeDir, "state", "events", "history.jsonl"),
	};
}

/**
 * An inert `AgentRunner` with a functional turn-state fake, for tests that drive the runtime's
 * ingress without a model. Pass overrides for the members a case cares about.
 */
export function createFakeRunner(overrides: Partial<AgentRunner> = {}): AgentRunner {
	return {
		...createFakeSessionBinding(),
		renderContextReport: () => "CONTEXT",
		getSubAgentDiscoverySnapshot: () => ({ directory: "", agents: [], warnings: [] }),
		run: vi.fn(async () => ({ stopReason: "stop" })),
		handleBuiltinCommand: vi.fn(async () => "HELP"),
		isKnownSlashCommand: vi.fn(() => false),
		queueSteer: vi.fn(async () => {}),
		flushMemoryForShutdown: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		getMemoryMaintenanceContext: vi.fn(async () => {
			throw new Error("not used");
		}),
		getStatusSnapshot: vi.fn(() => ({
			model: "test/model",
			contextTokens: 0,
			contextWindow: 200_000,
			thinkingLevel: "off",
		})),
		abort: vi.fn(async () => {}),
		...createFakeTurnState(),
		...overrides,
	};
}
