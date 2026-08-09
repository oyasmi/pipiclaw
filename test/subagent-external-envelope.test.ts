import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../src/executor.js";
import type { SubAgentConfig } from "../src/subagents/discovery.js";
import { configureSubAgentRuntime } from "../src/subagents/runs.js";
import { createSubAgentTool } from "../src/subagents/tool.js";
import { useTempDirs } from "./helpers/fixtures.js";

/**
 * P0-3: external roles must get the same task envelope internal workers do (runtime paths,
 * injected context blocks, and the verify protocol), not the raw task text. `launchExternalRun`
 * is mocked so this only exercises `createSubAgentTool`'s envelope construction, never a real
 * process.
 */

const { launchExternalRunMock } = vi.hoisted(() => ({
	launchExternalRunMock: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("../src/subagents/external/run.js", () => ({ launchExternalRun: launchExternalRunMock }));

const createTempWorkspace = useTempDirs("pipiclaw-subagent-external-envelope-");
const model = getModel("openai", "gpt-4o-mini")!;
const fakeExecutor: Executor = {
	async exec() {
		return { stdout: "", stderr: "", code: 0 };
	},
};

const baseRole = {
	description: "d",
	systemPrompt: "You do the thing.",
	tools: [] as SubAgentConfig["tools"],
	maxTurns: 24,
	maxToolCalls: 48,
	maxWallTimeSec: 1800,
	bashTimeoutSec: 120,
	source: "predefined",
	runtime: "external",
	harness: "codex-cli",
	command: "codex exec",
	mutates: "read",
} as const;

describe("createSubAgentTool external dispatch envelope (spec 040, P0-3)", () => {
	it("carries runtime paths and preferred-focus paths into the external task, not just the raw text", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext_envelope");
		mkdirSync(channelDir, { recursive: true });

		const researcherRole: SubAgentConfig = {
			...baseRole,
			name: "researcher",
			contextMode: "contextual",
			memory: "none",
			paths: ["src/foo.ts"],
		};

		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => ({
				directory: `${workspaceDir}/sub-agents`,
				agents: [researcherRole],
				warnings: [],
			}),
			runtimeContext: { workspaceDir, channelId: "dm_ext_envelope" },
		});

		const result = await tool.execute("call-1", {
			label: "research",
			agent: "researcher",
			task: "Investigate the bug.",
		});

		expect(launchExternalRunMock).toHaveBeenCalledTimes(1);
		const input = launchExternalRunMock.mock.calls[0]?.[0] as { task: string; artifactDir: string };
		expect(input.task).toContain("Investigate the bug.");
		expect(input.task).toContain(`Working directory: ${process.cwd()}`);
		expect(input.task).toContain(`Artifact directory: ${input.artifactDir}`);
		expect(input.task).toContain("Preferred focus paths:");
		expect(input.task).toContain("src/foo.ts");
		expect(result.details.dispatched).toBe(true);
	});

	it("carries the verification protocol into a purpose=verify external run", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext_envelope_verify");
		mkdirSync(join(channelDir, "tasks"), { recursive: true });
		writeFileSync(join(channelDir, "tasks", "ship.md"), "---\nstatus: open\n---\n# Ship\n\n## DoD\n- checks pass\n");

		const checkerRole: SubAgentConfig = {
			...baseRole,
			name: "checker",
			contextMode: "isolated",
			memory: "none",
			paths: [],
		};

		const tool = createSubAgentTool({
			executor: fakeExecutor,
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => ({ directory: `${workspaceDir}/sub-agents`, agents: [checkerRole], warnings: [] }),
			runtimeContext: { workspaceDir, channelId: "dm_ext_envelope_verify" },
		});

		await tool.execute("call-2", {
			label: "verify ship",
			agent: "checker",
			task: "Run the acceptance plan.",
			purpose: "verify",
			taskId: "ship",
		});

		expect(launchExternalRunMock).toHaveBeenCalledTimes(1);
		const input = launchExternalRunMock.mock.calls[0]?.[0] as { task: string };
		expect(input.task).toContain(join(channelDir, "tasks", "ship.md"));
		expect(input.task).toContain("VERDICT: PASS or VERDICT: FAIL");
	});
});
