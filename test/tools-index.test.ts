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

const securityConfig = {
	enabled: true,
	commandGuard: {
		enabled: true,
		additionalDenyPatterns: [],
		allowPatterns: [],
		blockObfuscation: true,
	},
	pathGuard: {
		enabled: true,
		readAllow: [],
		readDeny: [],
		writeAllow: [],
		writeDeny: [],
		resolveSymlinks: true,
	},
	audit: {
		logBlocked: true,
	},
};

vi.mock("../src/tools/read.js", () => ({ createReadTool: createReadToolMock }));
vi.mock("../src/tools/bash.js", () => ({ createBashTool: createBashToolMock }));
vi.mock("../src/tools/edit.js", () => ({ createEditTool: createEditToolMock }));
vi.mock("../src/tools/write.js", () => ({ createWriteTool: createWriteToolMock }));
vi.mock("../src/subagents/tool.js", () => ({ createSubAgentTool: createSubAgentToolMock }));
vi.mock("../src/security/config.js", () => ({ loadSecurityConfig: vi.fn(() => securityConfig) }));

import { createPipiclawBaseTools, createPipiclawTools } from "../src/tools/index.js";

const executor: Executor = {
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	getWorkspacePath: (hostPath) => hostPath,
};

describe("tools index", () => {
	it("creates the base tool set in the expected order", () => {
		const tools = createPipiclawBaseTools(executor);

		expect(createReadToolMock).toHaveBeenCalledWith(executor, undefined);
		expect(createBashToolMock).toHaveBeenCalledWith(executor, undefined);
		expect(createEditToolMock).toHaveBeenCalledWith(executor, undefined);
		expect(createWriteToolMock).toHaveBeenCalledWith(executor, undefined);
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
		expect(createReadToolMock).toHaveBeenCalledWith(executor, {
			securityConfig,
			securityContext: {
				workspaceDir: "/repo",
				workspacePath: "/workspace",
				cwd: process.cwd(),
			},
			channelId: "dm_42",
		});
		expect(createBashToolMock).toHaveBeenCalledWith(executor, {
			securityConfig,
			securityContext: {
				workspaceDir: "/repo",
				workspacePath: "/workspace",
				cwd: process.cwd(),
			},
			channelId: "dm_42",
		});
		expect(createSubAgentToolMock).toHaveBeenCalledWith({
			executor,
			getCurrentModel: options.getCurrentModel,
			getAvailableModels: options.getAvailableModels,
			resolveApiKey: options.resolveApiKey,
			workspaceDir: "/repo",
			channelDir: "/repo/dm_42",
			getSubAgentDiscovery: options.getSubAgentDiscovery,
			getMemoryRecallSettings: options.getMemoryRecallSettings,
			securityConfig,
			runtimeContext: {
				workspacePath: "/workspace",
				channelId: "dm_42",
				sandbox: "docker:pipiclaw",
			},
		});
	});
});
