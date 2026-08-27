import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../src/executor.js";
import { createFileStore } from "../src/file-store.js";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";

const {
	createReadToolMock,
	createBashToolMock,
	createEditToolMock,
	createGrepToolMock,
	createGlobToolMock,
	createWriteToolMock,
	createWebSearchToolMock,
	createWebFetchToolMock,
	createSessionSearchToolMock,
	createMemorySaveToolMock,
	createMemorySearchToolMock,
	createMemoryForgetToolMock,
	createSkillToolMock,
	createEventManageToolMock,
	createTaskListToolMock,
	createTaskCreateToolMock,
	createTaskUpdateToolMock,
	createTaskCloseToolMock,
	createTaskVerifyToolMock,
	createSubAgentToolMock,
	createSubAgentInlineToolMock,
	createSubAgentListToolMock,
	createSubAgentRunToolMock,
} = vi.hoisted(() => ({
	createReadToolMock: vi.fn(() => ({ name: "read" })),
	createBashToolMock: vi.fn(() => ({ name: "bash" })),
	createEditToolMock: vi.fn(() => ({ name: "edit" })),
	createGrepToolMock: vi.fn(() => ({ name: "grep" })),
	createGlobToolMock: vi.fn(() => ({ name: "glob" })),
	createWriteToolMock: vi.fn(() => ({ name: "write" })),
	createWebSearchToolMock: vi.fn(() => ({ name: "web_search" })),
	createWebFetchToolMock: vi.fn(() => ({ name: "web_fetch" })),
	createSessionSearchToolMock: vi.fn(() => ({ name: "session_search" })),
	createMemorySaveToolMock: vi.fn(() => ({ name: "memory_save" })),
	createMemorySearchToolMock: vi.fn(() => ({ name: "memory_search" })),
	createMemoryForgetToolMock: vi.fn(() => ({ name: "memory_forget" })),
	createSkillToolMock: vi.fn(() => ({ name: "skill" })),
	createEventManageToolMock: vi.fn(() => ({ name: "event_manage" })),
	createTaskListToolMock: vi.fn(() => ({ name: "task_list" })),
	createTaskCreateToolMock: vi.fn(() => ({ name: "task_create" })),
	createTaskUpdateToolMock: vi.fn(() => ({ name: "task_update" })),
	createTaskCloseToolMock: vi.fn(() => ({ name: "task_close" })),
	createTaskVerifyToolMock: vi.fn(() => ({ name: "task_verify" })),
	createSubAgentToolMock: vi.fn(() => ({ name: "subagent" })),
	createSubAgentInlineToolMock: vi.fn(() => ({ name: "subagent_inline" })),
	createSubAgentListToolMock: vi.fn(() => ({ name: "subagent_list" })),
	createSubAgentRunToolMock: vi.fn(() => ({ name: "subagent_run" })),
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
		subagentInline: {
			enabled: true,
		},
	},
};

vi.mock("../src/tools/read.js", () => ({ createReadTool: createReadToolMock }));
vi.mock("../src/tools/bash.js", () => ({ createBashTool: createBashToolMock }));
vi.mock("../src/tools/edit.js", () => ({ createEditTool: createEditToolMock }));
vi.mock("../src/tools/grep.js", () => ({ createGrepTool: createGrepToolMock }));
vi.mock("../src/tools/glob.js", () => ({ createGlobTool: createGlobToolMock }));
vi.mock("../src/tools/write.js", () => ({ createWriteTool: createWriteToolMock }));
vi.mock("../src/tools/web-search.js", () => ({ createWebSearchTool: createWebSearchToolMock }));
vi.mock("../src/tools/web-fetch.js", () => ({ createWebFetchTool: createWebFetchToolMock }));
vi.mock("../src/tools/session-search.js", () => ({ createSessionSearchTool: createSessionSearchToolMock }));
vi.mock("../src/tools/memory-manage.js", () => ({
	createMemorySaveTool: createMemorySaveToolMock,
	createMemorySearchTool: createMemorySearchToolMock,
	createMemoryForgetTool: createMemoryForgetToolMock,
}));
vi.mock("../src/tools/skill.js", () => ({ createSkillTool: createSkillToolMock }));
vi.mock("../src/tools/event-manage.js", () => ({ createEventManageTool: createEventManageToolMock }));
vi.mock("../src/tools/task-manage.js", () => ({
	createTaskListTool: createTaskListToolMock,
	createTaskCreateTool: createTaskCreateToolMock,
	createTaskUpdateTool: createTaskUpdateToolMock,
	createTaskCloseTool: createTaskCloseToolMock,
	createTaskVerifyTool: createTaskVerifyToolMock,
}));
vi.mock("../src/subagents/tool.js", () => ({
	createSubAgentTool: createSubAgentToolMock,
	createSubAgentInlineTool: createSubAgentInlineToolMock,
}));
vi.mock("../src/tools/subagent-manage.js", () => ({
	createSubAgentListTool: createSubAgentListToolMock,
	createSubAgentRunTool: createSubAgentRunToolMock,
}));
vi.mock("../src/security/config.js", () => ({ loadSecurityConfig: vi.fn(() => securityConfig) }));
vi.mock("../src/tools/config.js", () => ({ loadToolsConfig: vi.fn(() => toolsConfig) }));

import { buildPipiclawSystemPrompt } from "../src/agent/prompt/builder.js";
import { loadRuntimePlaybookCatalog, selectRuntimePlaybooks } from "../src/playbooks/catalog.js";
import { createPipiclawTools } from "../src/tools/index.js";

const baseToolOptions = {
	getCurrentModel: vi.fn(),
	getAvailableModels: vi.fn(() => []),
	resolveApiKey: vi.fn(),
	workspaceDir: "/repo",
	projectScope: {
		projectRoot: process.cwd(),
		boundary: "unbounded" as const,
		sandbox: { level: "application" as const, provider: "pipiclaw-path-guard", summary: "" },
	},
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
const fileStore = createFileStore();

describe("tools index", () => {
	beforeEach(() => {
		toolsConfig.tools.web.enable = true;
		toolsConfig.tools.tasks.enabled = true;
		createReadToolMock.mockClear();
		createBashToolMock.mockClear();
		createEditToolMock.mockClear();
		createGrepToolMock.mockClear();
		createGlobToolMock.mockClear();
		createWriteToolMock.mockClear();
		createWebSearchToolMock.mockClear();
		createWebFetchToolMock.mockClear();
		createSessionSearchToolMock.mockClear();
		createMemorySaveToolMock.mockClear();
		createSkillToolMock.mockClear();
		createSubAgentToolMock.mockClear();
	});

	it("always registers the job tool on the main path", () => {
		const baseArgs = {
			...baseToolOptions,
			executor,
			fileStore,
			memoryCandidateStore: createMemoryCandidateStore(),
		};

		expect(createPipiclawTools(baseArgs).map((tool) => tool.name)).toContain("job");
	});

	it("no longer lists tools in the prompt, but the tool set still gates mechanism sections", () => {
		// Spec 026 §3.2: the tool catalog is gone from the prompt; registration is unaffected,
		// and pi's tool schemas remain the source of truth for what is available.
		toolsConfig.tools.web.enable = false;
		const tools = createPipiclawTools({
			...baseToolOptions,
			executor,
			fileStore,
			memoryCandidateStore: createMemoryCandidateStore(),
		});
		const registered = new Set(tools.map((tool) => tool.name));
		const toolNames = tools.map((tool) => tool.name);
		const { text: prompt } = buildPipiclawSystemPrompt({
			mode: "normal",
			cwd: "/work",
			workspaceDir: "/workspace",
			tools: tools.map((tool) => ({ name: tool.name, description: "" })),
			playbooks: selectRuntimePlaybooks(loadRuntimePlaybookCatalog(), toolNames),
			subAgents: [],
		});

		// Registration itself is untouched by the prompt change (the "## Available Tools" absence
		// itself is covered by prompt-sections.test.ts).
		expect(registered.has("web_search")).toBe(false);
		expect(registered.has("memory_save")).toBe(true);
		// And the tool set still decides which mechanism sections render.
		expect(prompt).toContain("`memory_save` / `memory_forget` in the same turn");
		toolsConfig.tools.web.enable = true;
	});

	it("appends the subagent tool and passes runtime context", () => {
		const options = {
			...baseToolOptions,
			executor,
			fileStore,
			memoryCandidateStore: createMemoryCandidateStore(),
		};

		const tools = createPipiclawTools(options);
		// Spec 040, D8.1: the main agent's securityConfig gets workspace/sub-agents/ appended to
		// writeDeny before it reaches any leaf tool.
		const expectedSecurityConfig = {
			...securityConfig,
			pathGuard: { ...securityConfig.pathGuard, writeDeny: ["/repo/sub-agents"] },
		};

		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"bash",
			"edit",
			"grep",
			"glob",
			"write",
			"web_search",
			"web_fetch",
			"session_search",
			"memory_save",
			"memory_search",
			"memory_forget",
			"skill",
			"event_manage",
			"task_list",
			"task_create",
			"task_update",
			"task_close",
			"task_verify",
			"job",
			"subagent",
			"subagent_inline",
			"subagent_list",
			"subagent_run",
		]);
		expect(createReadToolMock).toHaveBeenCalledWith(executor, fileStore, {
			securityConfig: expectedSecurityConfig,
			securityContext: {
				agentWorkspaceDir: "/repo",
				projectRoot: process.cwd(),
				boundary: "unbounded",
				// Channel-bound leaf tools carry the channel directory so its files stay reachable
				// under `boundary: "project"` (spec 043, D5).
				channelDir: "/repo/dm_42",
			},
			channelId: "dm_42",
		});
		expect(createBashToolMock).toHaveBeenCalledWith(executor, {
			securityConfig: expectedSecurityConfig,
			securityContext: {
				agentWorkspaceDir: "/repo",
				projectRoot: process.cwd(),
				boundary: "unbounded",
				// Channel-bound leaf tools carry the channel directory so its files stay reachable
				// under `boundary: "project"` (spec 043, D5).
				channelDir: "/repo/dm_42",
			},
			channelId: "dm_42",
			rtkEnabled: false,
			interceptorEnabled: false,
			jobManager: expect.anything(),
		});
		expect(createWebSearchToolMock).toHaveBeenCalledWith({
			webConfig: toolsConfig.tools.web,
			securityConfig: expectedSecurityConfig,
			workspaceDir: "/repo",
			channelId: "dm_42",
		});
		expect(createWebFetchToolMock).toHaveBeenCalledWith({
			webConfig: toolsConfig.tools.web,
			securityConfig: expectedSecurityConfig,
			workspaceDir: "/repo",
			channelId: "dm_42",
			channelDir: "/repo/dm_42",
		});
		expect(createSubAgentToolMock).toHaveBeenCalledWith({
			executor,
			fileStore,
			getCurrentModel: options.getCurrentModel,
			getAvailableModels: options.getAvailableModels,
			resolveApiKey: options.resolveApiKey,
			workspaceDir: "/repo",
			workingDirectory: process.cwd(),
			projectBoundary: "unbounded",
			channelDir: "/repo/dm_42",
			getSubAgentDiscovery: options.getSubAgentDiscovery,
			getMemoryRecallSettings: options.getMemoryRecallSettings,
			memoryCandidateStore: options.memoryCandidateStore,
			securityConfig: expectedSecurityConfig,
			webConfig: toolsConfig.tools.web,
			rtkEnabled: false,
			runtimeContext: {
				workspaceDir: "/repo",
				channelId: "dm_42",
			},
		});
	});
});
