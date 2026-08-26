import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it, vi } from "vitest";
import type { Executor } from "../src/executor.js";
import { createFileStore } from "../src/file-store.js";
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
	launchExternalRunMock: vi.fn(async (..._args: unknown[]) => ({ ok: true }) as const),
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
			fileStore: createFileStore(),
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
			agent: "researcher",
			task: "Investigate the bug.",
		});

		expect(launchExternalRunMock).toHaveBeenCalledTimes(1);
		const input = launchExternalRunMock.mock.calls[0]?.[0] as {
			task: string;
			artifactDir: string;
			roleFingerprint?: string;
		};
		expect(input.task).toContain("Investigate the bug.");
		expect(input.task).toContain(`Working directory: ${process.cwd()}`);
		expect(input.task).toContain(`Artifact directory: ${input.artifactDir}`);
		expect(input.task).toContain("Preferred focus paths:");
		expect(input.task).toContain("src/foo.ts");
		expect(result.details.dispatched).toBe(true);
		// Spec 042, D3: the ARTIFACT marker protocol only ever meant something to the internal
		// `finalizeSubAgentOutput` parser — no external result parser reads it, so it must never be
		// injected into an external envelope even when the dispatch itself did not request it.
		expect(input.task).not.toContain("ARTIFACT:");
		// Spec 042, D7: the initial dispatch records the role's fingerprint at launch so a later
		// follow_up can detect a hot-edited role before resuming under it.
		expect(input.roleFingerprint).toBeDefined();
	});

	// Spec 046, D2.2 removed `returns: "artifact"` and the ARTIFACT marker protocol entirely (for
	// both internal and external roles) — a caller that needs a specific output file states the
	// path in the task text instead, which is what this rejection test used to steer external
	// callers toward. `subagentSchema`/`subagentInlineSchema` have no `returns` field any more, so
	// the rejection this test asserted is now a compile-time impossibility, not a runtime one.

	function writeSession(channelDir: string): void {
		writeFileSync(
			join(channelDir, "SESSION.md"),
			"# Session Title\n\n# Current State\n\nRefactoring the memory pipeline.\n",
			"utf-8",
		);
	}

	// Spec 042, D4: external memory defaults to "none" — a role that only wants `paths` injected
	// (contextMode: contextual, memory left unset) must not silently start sending channel session
	// state to a third-party process.
	it("does not inject session context when an external role's memory defaults to none", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext_no_memory");
		mkdirSync(channelDir, { recursive: true });
		writeSession(channelDir);

		const role: SubAgentConfig = {
			...baseRole,
			name: "scout",
			contextMode: "contextual",
			memory: "none", // discovery's own default for external — asserted directly here too
			paths: [],
		};

		const tool = createSubAgentTool({
			executor: fakeExecutor,
			fileStore: createFileStore(),
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => ({ directory: `${workspaceDir}/sub-agents`, agents: [role], warnings: [] }),
			runtimeContext: { workspaceDir, channelId: "dm_ext_no_memory" },
		});

		await tool.execute("call-no-memory", { agent: "scout", task: "Look around." });

		const input = launchExternalRunMock.mock.calls[0]?.[0] as { task: string };
		expect(input.task).not.toContain("Refactoring the memory pipeline.");
		expect(input.task).not.toContain("Relevant session state:");
	});

	it("injects session context when an external role explicitly declares memory: session", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext_with_memory");
		mkdirSync(channelDir, { recursive: true });
		writeSession(channelDir);

		const role: SubAgentConfig = {
			...baseRole,
			name: "scout",
			contextMode: "contextual",
			memory: "session", // an explicit, informed declaration — not the default
			paths: [],
		};

		const tool = createSubAgentTool({
			executor: fakeExecutor,
			fileStore: createFileStore(),
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => ({ directory: `${workspaceDir}/sub-agents`, agents: [role], warnings: [] }),
			runtimeContext: { workspaceDir, channelId: "dm_ext_with_memory" },
		});

		await tool.execute("call-with-memory", { agent: "scout", task: "Look around." });

		const input = launchExternalRunMock.mock.calls[0]?.[0] as { task: string };
		expect(input.task).toContain("Refactoring the memory pipeline.");
		expect(input.task).toContain("Relevant session state:");
	});

	// Spec 046, D2.1: `subagent` (role-based) no longer has a `context` override at all — a
	// configured role's contextMode/memory come from its own role file exclusively. The old
	// "invocation-side override wins" behavior this test asserted is gone; an isolated role stays
	// isolated no matter what the call says, because there is no field to say it with.
	it("an external role's context always comes from its own frontmatter — no invocation override exists", async () => {
		configureSubAgentRuntime({});
		launchExternalRunMock.mockClear();
		const workspaceDir = createTempWorkspace();
		const channelDir = join(workspaceDir, "dm_ext_invocation_context");
		mkdirSync(channelDir, { recursive: true });
		writeSession(channelDir);

		const role: SubAgentConfig = {
			...baseRole,
			name: "scout",
			contextMode: "isolated",
			memory: "none",
			paths: [],
		};

		const tool = createSubAgentTool({
			executor: fakeExecutor,
			fileStore: createFileStore(),
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => ({ directory: `${workspaceDir}/sub-agents`, agents: [role], warnings: [] }),
			runtimeContext: { workspaceDir, channelId: "dm_ext_invocation_context" },
		});

		await tool.execute("call-invocation-context", { agent: "scout", task: "Look around." });

		const input = launchExternalRunMock.mock.calls[0]?.[0] as { task: string };
		expect(input.task).not.toContain("Refactoring the memory pipeline.");
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
			fileStore: createFileStore(),
			getCurrentModel: () => model,
			getAvailableModels: () => [model],
			resolveApiKey: async () => "test-key",
			workspaceDir,
			channelDir,
			getSubAgentDiscovery: () => ({ directory: `${workspaceDir}/sub-agents`, agents: [checkerRole], warnings: [] }),
			runtimeContext: { workspaceDir, channelId: "dm_ext_envelope_verify" },
		});

		await tool.execute("call-2", {
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
