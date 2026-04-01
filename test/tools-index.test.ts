import { describe, expect, it, vi } from "vitest";
import type { Executor, SandboxConfig } from "../src/sandbox.js";

const { createReadToolMock, createBashToolMock, createEditToolMock, createWriteToolMock, createSubAgentToolMock } =
	vi.hoisted(() => ({
		createReadToolMock: vi.fn(() => ({ name: "read" })),
		createBashToolMock: vi.fn(() => ({ name: "bash" })),
		createEditToolMock: vi.fn(() => ({ name: "edit" })),
		createWriteToolMock: vi.fn(() => ({ name: "write" })),
		createSubAgentToolMock: vi.fn(() => ({ name: "subagent" })),
	}));

vi.mock("../src/tools/read.js", () => ({ createReadTool: createReadToolMock }));
vi.mock("../src/tools/bash.js", () => ({ createBashTool: createBashToolMock }));
vi.mock("../src/tools/edit.js", () => ({ createEditTool: createEditToolMock }));
vi.mock("../src/tools/write.js", () => ({ createWriteTool: createWriteToolMock }));
vi.mock("../src/subagents/tool.js", () => ({ createSubAgentTool: createSubAgentToolMock }));

import { createPipiclawBaseTools, createPipiclawTools } from "../src/tools/index.js";

const executor: Executor = {
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	getWorkspacePath: (hostPath) => hostPath,
};

describe("tools index", () => {
	it("creates the base tool set in the expected order", () => {
		const tools = createPipiclawBaseTools(executor);

		expect(createReadToolMock).toHaveBeenCalledWith(executor);
		expect(createBashToolMock).toHaveBeenCalledWith(executor);
		expect(createEditToolMock).toHaveBeenCalledWith(executor);
		expect(createWriteToolMock).toHaveBeenCalledWith(executor);
		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
	});

	it("appends the subagent tool and maps sandbox runtime context", () => {
		const options = {
			executor,
			getCurrentModel: vi.fn(),
			getAvailableModels: vi.fn(() => []),
			resolveApiKey: vi.fn(),
			workspaceDir: "/repo",
			channelDir: "/repo/dm_42",
			workspacePath: "/workspace",
			channelId: "dm_42",
			sandboxConfig: { type: "docker", container: "pipiclaw" } satisfies SandboxConfig,
			getSubAgentDiscovery: vi.fn(),
			getMemoryRecallSettings: vi.fn(() => ({
				enabled: true,
				maxCandidates: 8,
				maxInjected: 3,
				maxChars: 3500,
				rerankWithModel: false,
			})),
		};

		const tools = createPipiclawTools(options);

		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "subagent"]);
		expect(createSubAgentToolMock).toHaveBeenCalledWith({
			executor,
			getCurrentModel: options.getCurrentModel,
			getAvailableModels: options.getAvailableModels,
			resolveApiKey: options.resolveApiKey,
			workspaceDir: "/repo",
			channelDir: "/repo/dm_42",
			getSubAgentDiscovery: options.getSubAgentDiscovery,
			getMemoryRecallSettings: options.getMemoryRecallSettings,
			runtimeContext: {
				workspacePath: "/workspace",
				channelId: "dm_42",
				sandbox: "docker:pipiclaw",
			},
		});
	});
});
