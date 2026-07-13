import { describe, expect, it } from "vitest";
import {
	formatBusyCommandList,
	isKnownCommandName,
	isRunnerBuiltInCommand,
	parseBuiltInCommand,
	renderBuiltInHelp,
	slashCommandName,
} from "../src/agent/commands.js";

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
		expect(parseBuiltInCommand("/events show weekly-review")).toEqual({
			name: "events",
			args: "show weekly-review",
			rawText: "/events show weekly-review",
		});
	});

	it("returns null for non-built-in inputs", () => {
		expect(parseBuiltInCommand("hello")).toBeNull();
		expect(parseBuiltInCommand("/session")).toBeNull();
		expect(parseBuiltInCommand("/unknown something")).toBeNull();
	});

	it("splits on any whitespace so a newline after the command still parses", () => {
		expect(parseBuiltInCommand("/steer\n修复这个")).toEqual({
			name: "steer",
			args: "修复这个",
			rawText: "/steer\n修复这个",
		});
		expect(parseBuiltInCommand("/usage\t7d")).toMatchObject({ name: "usage", args: "7d" });
	});

	it("matches the command name case-insensitively", () => {
		expect(parseBuiltInCommand("/Help")).toMatchObject({ name: "help" });
		expect(parseBuiltInCommand("/STATUS")).toMatchObject({ name: "status" });
	});
});

describe("command metadata helpers", () => {
	it("recognizes built-in, session, and skill commands as known", () => {
		expect(isKnownCommandName("help")).toBe(true);
		expect(isKnownCommandName("model")).toBe(true);
		expect(isKnownCommandName("memory")).toBe(true);
		expect(isKnownCommandName("skill:foo")).toBe(true);
		expect(isKnownCommandName("modle")).toBe(false);
	});

	it("extracts the lower-cased command name from slash input", () => {
		expect(slashCommandName("/Model anthropic/x")).toBe("model");
		expect(slashCommandName("  /skill:foo bar ")).toBe("skill:foo");
		expect(slashCommandName("hello")).toBeNull();
	});

	it("narrows only the four runner-handled commands", () => {
		expect(isRunnerBuiltInCommand({ name: "steer", args: "", rawText: "/steer" })).toBe(true);
		expect(isRunnerBuiltInCommand({ name: "events", args: "", rawText: "/events" })).toBe(false);
	});

	it("lists the busy-available commands without session commands", () => {
		const list = formatBusyCommandList();
		expect(list).toContain("`/stop`");
		expect(list).toContain("`/status`");
		expect(list).not.toContain("/model");
	});

	it("renders help text that describes transport and session commands", () => {
		const help = renderBuiltInHelp();
		expect(help).toContain("# Slash Commands");
		expect(help).toContain("## Transport Commands");
		expect(help).toContain("## Session Commands");
		expect(help).toContain("/followup <message>");
		expect(help).toContain("/events <list|show|delete|history>");
		expect(help).toContain("busyMessageDefault");
		expect(help).toContain("responseMode");
		expect(help).toContain("/model [provider/modelId|modelId]");
		expect(help).toContain("/memory [status|list|show <id>|pending]");
	});
});
