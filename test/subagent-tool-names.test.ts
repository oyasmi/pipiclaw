import { describe, expect, it } from "vitest";
import { validateToolNames } from "../src/subagents/discovery.js";
import { TOOL_REGISTRY } from "../src/tools/registry.js";
import { SUBAGENT_TOOL_NAMES } from "../src/tools/subagent-tool-names.js";

describe("sub-agent tool names — single source of truth (batch 3.1)", () => {
	it("the registry's `availableToSubagents` set equals the shared whitelist", () => {
		// Regression: the two lists were maintained by hand and drifted — `glob` was
		// build-available but role validation rejected it. Mutation check: add a tool to
		// SUBAGENT_TOOL_NAMES without flagging it in the registry (or vice-versa) and this fails.
		const registrySet = new Set(TOOL_REGISTRY.filter((r) => r.availableToSubagents).map((r) => r.name));
		expect([...registrySet].sort()).toEqual([...SUBAGENT_TOOL_NAMES].sort());
	});

	it("validateToolNames now accepts `glob`", () => {
		expect(validateToolNames(["read", "glob"]).error).toBeUndefined();
		expect(validateToolNames(["read", "glob"]).tools).toEqual(["read", "glob"]);
	});

	it("validateToolNames still rejects an unknown tool", () => {
		expect(validateToolNames(["read", "not_a_tool"]).error).toMatch(/Unknown tool/);
	});
});
