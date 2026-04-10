import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";
import type { Executor, SandboxConfig } from "../src/sandbox.js";

const {
	createReadToolMock,
	createBashToolMock,
	createEditToolMock,
	createWriteToolMock,
	createWebSearchToolMock,
	createWebFetchToolMock,
	createSubAgentToolMock,
} = vi.hoisted(() => ({
	createReadToolMock: vi.fn(() => ({ name: "read" })),
	createBashToolMock: vi.fn(() => ({ name: "bash" })),
	createEditToolMock: vi.fn(() => ({ name: "edit" })),
	createWriteToolMock: vi.fn(() => ({ name: "write" })),
	createWebSearchToolMock: vi.fn(() => ({ name: "web_search" })),
	createWebFetchToolMock: vi.fn(() => ({ name: "web_fetch" })),
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
	networkGuard: {
		enabled: true,
		allowedCidrs: [],
		allowedHosts: [],
		maxRedirects: 5,
	},
	audit: {
		logBlocked: true,
	},
};

const toolsConfig = {
	tools: {
		web: {
			enable: true,
			proxy: null,
			search: {
				provider: "duckduckgo",
				apiKey: "",
				baseUrl: "",
				maxResults: 5,
				timeoutMs: 30000,
			},
			fetch: {
				maxChars: 50000,
				timeoutMs: 30000,
				maxImageBytes: 10485760,
				preferJina: false,
				enableJinaFallback: false,
				defaultExtractMode: "markdown",
			},
		},
	},
};

vi.mock("../src/tools/read.js", () => ({ createReadTool: createReadToolMock }));
vi.mock("../src/tools/bash.js", () => ({ createBashTool: createBashToolMock }));
vi.mock("../src/tools/edit.js", () => ({ createEditTool: createEditToolMock }));
vi.mock("../src/tools/write.js", () => ({ createWriteTool: createWriteToolMock }));
vi.mock("../src/tools/web-search.js", () => ({ createWebSearchTool: createWebSearchToolMock }));
vi.mock("../src/tools/web-fetch.js", () => ({ createWebFetchTool: createWebFetchToolMock }));
vi.mock("../src/subagents/tool.js", () => ({ createSubAgentTool: createSubAgentToolMock }));
vi.mock("../src/security/config.js", () => ({ loadSecurityConfig: vi.fn(() => securityConfig) }));
vi.mock("../src/tools/config.js", () => ({ loadToolsConfig: vi.fn(() => toolsConfig) }));

import { createPipiclawBaseTools, createPipiclawTools } from "../src/tools/index.js";

const executor: Executor = {
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	getWorkspacePath: (hostPath) => hostPath,
};

describe("tools index", () => {
	beforeEach(() => {
		toolsConfig.tools.web.enable = true;
		createReadToolMock.mockClear();
		createBashToolMock.mockClear();
		createEditToolMock.mockClear();
		createWriteToolMock.mockClear();
		createWebSearchToolMock.mockClear();
		createWebFetchToolMock.mockClear();
		createSubAgentToolMock.mockClear();
	});

	it("skips web tools when tools.web.enable is false", () => {
		toolsConfig.tools.web.enable = false;
		const tools = createPipiclawTools({
			executor,
			getCurrentModel: vi.fn(),
			getAvailableModels: vi.fn(() => []),
			resolveApiKey: vi.fn(),
			workspaceDir: "/repo",
			channelDir: "/repo/dm_42",
			workspacePath: "/workspace",
			channelId: "dm_42",
			sandboxConfig: { type: "host" },
			getSubAgentDiscovery: vi.fn(),
			getMemoryRecallSettings: vi.fn(() => ({
				enabled: true,
				maxCandidates: 8,
				maxInjected: 3,
				maxChars: 3500,
				rerankWithModel: false,
			})),
			memoryCandidateStore: createMemoryCandidateStore(),
		});

		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "subagent"]);
		expect(createWebSearchToolMock).not.toHaveBeenCalled();
		expect(createWebFetchToolMock).not.toHaveBeenCalled();
		toolsConfig.tools.web.enable = true;
	});

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
			memoryCandidateStore: createMemoryCandidateStore(),
		};

		const tools = createPipiclawTools(options);

		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"web_search",
			"web_fetch",
			"subagent",
		]);
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
		expect(createWebSearchToolMock).toHaveBeenCalledWith({
			webConfig: toolsConfig.tools.web,
			securityConfig,
			workspaceDir: "/repo",
			channelId: "dm_42",
		});
		expect(createWebFetchToolMock).toHaveBeenCalledWith({
			webConfig: toolsConfig.tools.web,
			securityConfig,
			workspaceDir: "/repo",
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
			memoryCandidateStore: options.memoryCandidateStore,
			securityConfig,
			webConfig: toolsConfig.tools.web,
			runtimeContext: {
				workspacePath: "/workspace",
				channelId: "dm_42",
				sandbox: "docker:pipiclaw",
			},
		});
	});
});
