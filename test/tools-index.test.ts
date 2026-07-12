import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../src/executor.js";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";

const {
	createReadToolMock,
	createBashToolMock,
	createEditToolMock,
	createGrepToolMock,
	createWriteToolMock,
	createWebSearchToolMock,
	createWebFetchToolMock,
	createSessionSearchToolMock,
	createMemoryManageToolMock,
	createSkillManageToolMock,
	createEventManageToolMock,
	createTaskManageToolMock,
	createSubAgentToolMock,
} = vi.hoisted(() => ({
	createReadToolMock: vi.fn(() => ({ name: "read" })),
	createBashToolMock: vi.fn(() => ({ name: "bash" })),
	createEditToolMock: vi.fn(() => ({ name: "edit" })),
	createGrepToolMock: vi.fn(() => ({ name: "grep" })),
	createWriteToolMock: vi.fn(() => ({ name: "write" })),
	createWebSearchToolMock: vi.fn(() => ({ name: "web_search" })),
	createWebFetchToolMock: vi.fn(() => ({ name: "web_fetch" })),
	createSessionSearchToolMock: vi.fn(() => ({ name: "session_search" })),
	createMemoryManageToolMock: vi.fn(() => ({ name: "memory_manage" })),
	createSkillManageToolMock: vi.fn(() => ({ name: "skill_manage" })),
	createEventManageToolMock: vi.fn(() => ({ name: "event_manage" })),
	createTaskManageToolMock: vi.fn(() => ({ name: "task_manage" })),
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
		tasks: {
			enabled: true,
		},
		bashInterceptor: {
			enabled: false,
		},
		rtk: {
			enabled: false,
		},
	},
};

vi.mock("../src/tools/read.js", () => ({ createReadTool: createReadToolMock }));
vi.mock("../src/tools/bash.js", () => ({ createBashTool: createBashToolMock }));
vi.mock("../src/tools/edit.js", () => ({ createEditTool: createEditToolMock }));
vi.mock("../src/tools/grep.js", () => ({ createGrepTool: createGrepToolMock }));
vi.mock("../src/tools/write.js", () => ({ createWriteTool: createWriteToolMock }));
vi.mock("../src/tools/web-search.js", () => ({ createWebSearchTool: createWebSearchToolMock }));
vi.mock("../src/tools/web-fetch.js", () => ({ createWebFetchTool: createWebFetchToolMock }));
vi.mock("../src/tools/session-search.js", () => ({ createSessionSearchTool: createSessionSearchToolMock }));
vi.mock("../src/tools/memory-manage.js", () => ({ createMemoryManageTool: createMemoryManageToolMock }));
vi.mock("../src/tools/skill-manage.js", () => ({ createSkillManageTool: createSkillManageToolMock }));
vi.mock("../src/tools/event-manage.js", () => ({ createEventManageTool: createEventManageToolMock }));
vi.mock("../src/tools/task-manage.js", () => ({ createTaskManageTool: createTaskManageToolMock }));
vi.mock("../src/subagents/tool.js", () => ({ createSubAgentTool: createSubAgentToolMock }));
vi.mock("../src/security/config.js", () => ({ loadSecurityConfig: vi.fn(() => securityConfig) }));
vi.mock("../src/tools/config.js", () => ({ loadToolsConfig: vi.fn(() => toolsConfig) }));

import { buildAppendSystemPrompt } from "../src/agent/prompt-builder.js";
import { createPipiclawTools } from "../src/tools/index.js";

const ALL_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"grep",
	"write",
	"web_search",
	"web_fetch",
	"session_search",
	"memory_manage",
	"skill_manage",
	"event_manage",
	"task_manage",
	"job",
	"subagent",
];

const baseToolOptions = {
	getCurrentModel: vi.fn(),
	getAvailableModels: vi.fn(() => []),
	resolveApiKey: vi.fn(),
	workspaceDir: "/repo",
	channelDir: "/repo/dm_42",
	channelId: "dm_42",
	getSubAgentDiscovery: vi.fn(),
	getMemoryRecallSettings: vi.fn(() => ({
		enabled: true,
		maxCandidates: 8,
		maxInjected: 3,
		maxChars: 3500,
		rerankWithModel: false,
	})),
	getSessionSearchSettings: vi.fn(() => ({
		enabled: true,
		maxFiles: 12,
		maxChunks: 80,
		maxCharsPerChunk: 1200,
		summarizeWithModel: false,
		timeoutMs: 12000,
	})),
};

const executor: Executor = {
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
};

describe("tools index", () => {
	beforeEach(() => {
		toolsConfig.tools.web.enable = true;
		toolsConfig.tools.tasks.enabled = true;
		createReadToolMock.mockClear();
		createBashToolMock.mockClear();
		createEditToolMock.mockClear();
		createGrepToolMock.mockClear();
		createWriteToolMock.mockClear();
		createWebSearchToolMock.mockClear();
		createWebFetchToolMock.mockClear();
		createSessionSearchToolMock.mockClear();
		createMemoryManageToolMock.mockClear();
		createSkillManageToolMock.mockClear();
		createSubAgentToolMock.mockClear();
	});

	it("always registers the job tool on the main path and honors the tasks master switch", () => {
		const baseArgs = {
			...baseToolOptions,
			executor,
			memoryCandidateStore: createMemoryCandidateStore(),
		};

		expect(createPipiclawTools(baseArgs).map((tool) => tool.name)).toContain("job");

		toolsConfig.tools.tasks.enabled = false;
		expect(
			createPipiclawTools({ ...baseArgs, memoryCandidateStore: createMemoryCandidateStore() }).map((t) => t.name),
		).not.toContain("task_manage");
	});

	it("keeps the system prompt tool list in sync with the registered tools", () => {
		// Web tools disabled: they must vanish from BOTH the registered set and the prompt.
		toolsConfig.tools.web.enable = false;
		const tools = createPipiclawTools({
			...baseToolOptions,
			executor,
			memoryCandidateStore: createMemoryCandidateStore(),
		});
		const registered = new Set(tools.map((tool) => tool.name));
		const prompt = buildAppendSystemPrompt("/workspace", "dm_42", {
			tools: tools.map((tool) => ({ name: tool.name, description: "" })),
		});

		for (const name of ALL_TOOL_NAMES) {
			const line = `- ${name}:`;
			if (registered.has(name)) {
				expect(prompt).toContain(line);
			} else {
				expect(prompt).not.toContain(line);
			}
		}
		// Concrete drift assertions for the previously-broken cases.
		expect(registered.has("web_search")).toBe(false);
		expect(prompt).not.toContain("return untrusted external content");
		expect(registered.has("memory_manage")).toBe(true);
		expect(prompt).toContain("- memory_manage:");
		toolsConfig.tools.web.enable = true;
	});

	it("appends the subagent tool and passes runtime context", () => {
		const options = {
			...baseToolOptions,
			executor,
			memoryCandidateStore: createMemoryCandidateStore(),
		};

		const tools = createPipiclawTools(options);

		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"bash",
			"edit",
			"grep",
			"write",
			"web_search",
			"web_fetch",
			"session_search",
			"memory_manage",
			"skill_manage",
			"event_manage",
			"task_manage",
			"job",
			"subagent",
		]);
		expect(createReadToolMock).toHaveBeenCalledWith(executor, {
			securityConfig,
			securityContext: {
				workspaceDir: "/repo",
				cwd: process.cwd(),
			},
			channelId: "dm_42",
		});
		expect(createBashToolMock).toHaveBeenCalledWith(executor, {
			securityConfig,
			securityContext: {
				workspaceDir: "/repo",
				cwd: process.cwd(),
			},
			channelId: "dm_42",
			rtkEnabled: false,
			interceptorEnabled: false,
			jobManager: expect.anything(),
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
			channelDir: "/repo/dm_42",
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
			rtkEnabled: false,
			runtimeContext: {
				workspaceDir: "/repo",
				channelId: "dm_42",
			},
		});
	});
});
