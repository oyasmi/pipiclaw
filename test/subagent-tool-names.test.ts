import { describe, expect, it } from "vitest";
import { validateToolNames } from "../src/subagents/discovery.js";
import { TOOL_REGISTRY } from "../src/tools/registry.js";
import { SUBAGENT_TOOL_NAMES } from "../src/tools/subagent-tool-names.js";

describe("sub-agent tool names — single source of truth (batch 3.1)", () => {
	it("validateToolNames accepts the registered allowlist", () => {
		expect(SUBAGENT_TOOL_NAMES.every((name) => TOOL_REGISTRY.some((r) => r.name === name))).toBe(true);
		expect(validateToolNames([...SUBAGENT_TOOL_NAMES]).error).toBeUndefined();
		expect(validateToolNames([...SUBAGENT_TOOL_NAMES]).tools).toEqual(SUBAGENT_TOOL_NAMES);
	});

	it("validateToolNames still rejects an unknown tool", () => {
		expect(validateToolNames(["read", "not_a_tool"]).error).toMatch(/Unknown tool/);
	});
});
