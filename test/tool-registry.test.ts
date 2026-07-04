import { describe, expect, it } from "vitest";
import { createMemoryCandidateStore } from "../src/memory/candidates.js";
import type { Executor } from "../src/sandbox.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { buildToolSet, TOOL_PROMPT_HINTS, TOOL_REGISTRY, type ToolBuildContext } from "../src/tools/registry.js";

const executor: Executor = {
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	getWorkspacePath: (hostPath) => hostPath,
};

function makeContext(overrides: Partial<ToolBuildContext> = {}): ToolBuildContext {
	return {
		executor,
		securityConfig: DEFAULT_SECURITY_CONFIG,
		securityContext: { workspaceDir: "/repo", workspacePath: "/workspace", cwd: "/repo" },
		channelId: "dm_1",
		channelDir: "/repo/dm_1",
		workspaceDir: "/repo",
		workspacePath: "/workspace",
		webConfig: { ...DEFAULT_TOOLS_CONFIG.tools.web, enable: true },
		toolsConfig: DEFAULT_TOOLS_CONFIG,
		getCurrentModel: () => ({}) as never,
		getAvailableModels: () => [],
		resolveApiKey: async () => "key",
		getSessionSearchSettings: () =>
			({
				enabled: true,
				maxFiles: 12,
				maxChunks: 80,
				maxCharsPerChunk: 1200,
				summarizeWithModel: false,
				timeoutMs: 12000,
			}) as never,
		memoryCandidateStore: createMemoryCandidateStore(),
		...overrides,
	};
}

describe("tool registry", () => {
	it("has unique names and a non-empty prompt hint for every tool", () => {
		const names = TOOL_REGISTRY.map((registration) => registration.name);
		expect(new Set(names).size).toBe(names.length);
		for (const registration of TOOL_REGISTRY) {
			expect(registration.promptHint.trim().length).toBeGreaterThan(0);
		}
	});

	it("does not register the subagent tool (it is appended separately)", () => {
		expect(TOOL_REGISTRY.map((registration) => registration.name)).not.toContain("subagent");
	});

	it("exposes a prompt hint for every registered tool plus subagent", () => {
		for (const registration of TOOL_REGISTRY) {
			expect(TOOL_PROMPT_HINTS[registration.name]).toBeTruthy();
		}
		expect(TOOL_PROMPT_HINTS.subagent).toBeTruthy();
	});

	it("builds the full leaf set on the main path in registry order", () => {
		const tools = buildToolSet(makeContext());
		expect(tools.map((tool) => tool.name)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"web_search",
			"web_fetch",
			"session_search",
			"memory_save",
			"skill_list",
			"skill_view",
			"skill_manage",
		]);
	});

	it("restricts the sub-agent set to file and web tools", () => {
		const tools = buildToolSet(makeContext(), { forSubagent: true });
		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "web_search", "web_fetch"]);
	});

	it("omits web tools for sub-agents when no web config is present", () => {
		const tools = buildToolSet(makeContext({ webConfig: undefined }), { forSubagent: true });
		expect(tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
	});

	it("honors config gates on the main path", () => {
		const toolsConfig = {
			tools: {
				...DEFAULT_TOOLS_CONFIG.tools,
				web: { ...DEFAULT_TOOLS_CONFIG.tools.web, enable: false },
				memory: { sessionSearch: { enabled: false }, save: { enabled: true } },
				skills: { manage: { enabled: false } },
			},
		};
		const tools = buildToolSet(makeContext({ toolsConfig, webConfig: toolsConfig.tools.web }));
		const names = tools.map((tool) => tool.name);
		expect(names).not.toContain("web_search");
		expect(names).not.toContain("session_search");
		expect(names).not.toContain("skill_manage");
		expect(names).toContain("memory_save");
	});
});
