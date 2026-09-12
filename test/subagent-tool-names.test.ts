import { describe, expect, it } from "vitest";
import { validateToolNames } from "../src/subagents/discovery.js";
import { TOOL_REGISTRY } from "../src/tools/registry.js";
import { SUBAGENT_TOOL_NAMES } from "../src/tools/subagent-tool-names.js";

describe("sub-agent tool names — single source of truth (batch 3.1)", () => {
	it("every allowed sub-agent tool has a registered implementation", () => {
		const registered = new Set(TOOL_REGISTRY.map((r) => r.name));
		for (const name of SUBAGENT_TOOL_NAMES) expect(registered.has(name)).toBe(true);
	});

	it("validateToolNames now accepts `glob`", () => {
		expect(validateToolNames(["read", "glob"]).error).toBeUndefined();
		expect(validateToolNames(["read", "glob"]).tools).toEqual(["read", "glob"]);
	});

	it("validateToolNames still rejects an unknown tool", () => {
		expect(validateToolNames(["read", "not_a_tool"]).error).toMatch(/Unknown tool/);
	});
});
