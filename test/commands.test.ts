import { describe, expect, it } from "vitest";
import { parseBuiltInCommand, renderBuiltInHelp } from "../src/agent/commands.js";

describe("commands", () => {
	it("parses built-in commands with trimmed arguments", () => {
		expect(parseBuiltInCommand("  /help  ")).toEqual({
			name: "help",
			args: "",
			rawText: "/help",
		});
		expect(parseBuiltInCommand("/steer   focus on latest changes  ")).toEqual({
			name: "steer",
			args: "focus on latest changes",
			rawText: "/steer   focus on latest changes",
		});
		expect(parseBuiltInCommand("/followup next task")).toEqual({
			name: "followup",
			args: "next task",
			rawText: "/followup next task",
		});
		expect(parseBuiltInCommand("/stop")).toEqual({
			name: "stop",
			args: "",
			rawText: "/stop",
		});
	});

	it("returns null for non-built-in inputs", () => {
		expect(parseBuiltInCommand("hello")).toBeNull();
		expect(parseBuiltInCommand("/session")).toBeNull();
		expect(parseBuiltInCommand("/unknown something")).toBeNull();
	});

	it("renders help text that describes transport and session commands", () => {
		const help = renderBuiltInHelp();
		expect(help).toContain("# Slash Commands");
		expect(help).toContain("## Transport Commands");
		expect(help).toContain("## Session Commands");
		expect(help).toContain("/followup <message>");
		expect(help).toContain("busyMessageDefault");
		expect(help).toContain("/model [provider/modelId|modelId]");
	});
});
