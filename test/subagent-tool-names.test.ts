import { describe, expect, it } from "vitest";
import { validateToolNames } from "../src/subagents/discovery.js";
import { SUBAGENT_TOOL_NAMES } from "../src/tools/contract/names.js";
import { TOOL_REGISTRY } from "../src/tools/registry.js";

describe("sub-agent tool names — single source of truth (batch 3.1)", () => {
	it("accepts implemented allowlist entries and rejects unknown tools", () => {
		expect(SUBAGENT_TOOL_NAMES.every((name) => TOOL_REGISTRY.some((r) => r.name === name))).toBe(true);
		expect(validateToolNames([...SUBAGENT_TOOL_NAMES]).error).toBeUndefined();
		expect(validateToolNames([...SUBAGENT_TOOL_NAMES]).tools).toEqual(SUBAGENT_TOOL_NAMES);
		expect(validateToolNames(["read", "not_a_tool"]).error).toBeDefined();
	});
});
