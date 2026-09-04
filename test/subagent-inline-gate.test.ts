import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { createFileStore } from "../src/file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { DEFAULT_TOOLS_CONFIG } from "../src/tools/config.js";
import { createPipiclawTools } from "../src/tools/index.js";

/**
 * Spec 046, D2.3: `tools.subagentInline.enabled` gates `subagent_inline` the same way
 * `tools.tasks.enabled` already gates `task_manage` (`src/tools/registry.ts`'s `enabledBy`) —
 * disabled means the tool is absent from the built set entirely, not merely rejected at call
 * time. There is no separate execution-time double-check to test: like every other config-gated
 * tool in this registry, a disabled tool has nothing built for the model to call in the first
 * place, so an attempted call fails the same way calling any nonexistent tool name would.
 */

const model = getModel("openai", "gpt-4o-mini")!;

function makeOptions(subagentInlineEnabled: boolean) {
	return {
		executor: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
		fileStore: createFileStore(),
		getCurrentModel: () => model,
		getAvailableModels: () => [model],
		resolveApiKey: async () => "test-key",
		workspaceDir: "/repo",
		projectScope: {
			projectRoot: process.cwd(),
			boundary: "unbounded" as const,
			sandbox: { level: "application" as const, provider: "pipiclaw-path-guard", summary: "" },
		},
		channelDir: "/repo/dm_1",
		channelId: "dm_1",
		getSubAgentDiscovery: () => ({ directory: "/repo/sub-agents", warnings: [], agents: [] }),
		getSessionSearchSettings: () => ({
			enabled: true,
			maxFiles: 12,
			maxChunks: 80,
			maxCharsPerChunk: 1200,
			summarizeWithModel: false,
			timeoutMs: 12000,
		}),
		securityConfig: DEFAULT_SECURITY_CONFIG,
		toolsConfig: {
			...DEFAULT_TOOLS_CONFIG,
			tools: { ...DEFAULT_TOOLS_CONFIG.tools, subagentInline: { enabled: subagentInlineEnabled } },
		},
	};
}

describe("subagent_inline tool gate (spec 046, D2.3)", () => {
	it("registers subagent_inline alongside subagent when the gate defaults/opts in", () => {
		const names = createPipiclawTools(makeOptions(true)).map((tool) => tool.name);
		expect(names).toContain("subagent");
		expect(names).toContain("subagent_inline");
	});

	it("describes inline as an advanced fallback with a complete independent control surface", () => {
		const inline = createPipiclawTools(makeOptions(true)).find((tool) => tool.name === "subagent_inline");
		if (!inline) throw new Error("subagent_inline not registered");

		expect(inline.description).toContain("Advanced fallback only, not the default");
		expect(inline.description).toContain("use `subagent` first");
		expect(inline.description).toContain("only when no configured role is suitable");
		expect(inline.description).toContain("raw one-shot meta-executor");
		expect(inline.description).toContain("not a shorthand for `subagent`");
		for (const field of [
			"task",
			"systemPrompt",
			"tools",
			"model",
			"effort",
			"context",
			"thinkingLevel",
			"mutates",
			"workingDirectory",
			"purpose",
			"taskId",
		]) {
			expect(inline.description).toContain(`\`${field}\``);
		}
	});

	it("omits subagent_inline entirely when the gate is off, while subagent stays available", () => {
		const names = createPipiclawTools(makeOptions(false)).map((tool) => tool.name);
		expect(names).toContain("subagent");
		expect(names).not.toContain("subagent_inline");
	});
});
