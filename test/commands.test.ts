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
	it("parses built-in commands: trimming, any-whitespace splits, and case-insensitive names", () => {
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
		// Any whitespace separates the command from its args, including newlines and tabs...
		expect(parseBuiltInCommand("/steer\n修复这个")).toEqual({
			name: "steer",
			args: "修复这个",
			rawText: "/steer\n修复这个",
		});
		expect(parseBuiltInCommand("/usage\t7d")).toMatchObject({ name: "usage", args: "7d" });
		// ...and the command name itself matches case-insensitively.
		expect(parseBuiltInCommand("/Help")).toMatchObject({ name: "help" });
		expect(parseBuiltInCommand("/STATUS")).toMatchObject({ name: "status" });
	});

	it("returns null for anything outside the roster, including CLI-only /login", () => {
		expect(parseBuiltInCommand("hello")).toBeNull();
		expect(parseBuiltInCommand("/session")).toBeNull();
		expect(parseBuiltInCommand("/unknown something")).toBeNull();
		// Provider login is a CLI-only operation (spec 039 §3.1).
		expect(parseBuiltInCommand("/login")).toBeNull();
		expect(isKnownCommandName("login")).toBe(false);
	});
});

describe("command metadata helpers", () => {
	it("recognizes roster names as known and gates skill invocations on the roster (review 2026-08-24 §1.9)", () => {
		expect(isKnownCommandName("help")).toBe(true);
		expect(isKnownCommandName("model")).toBe(true);
		expect(isKnownCommandName("memory")).toBe(true);
		expect(isKnownCommandName("modle")).toBe(false);
		// A skill invocation is only recognized when its name is in the provided skill roster.
		expect(isKnownCommandName("skill:foo")).toBe(false);
		expect(isKnownCommandName("skill:foo", [])).toBe(false);
		expect(isKnownCommandName("skill:foo", ["bar"])).toBe(false);
		expect(isKnownCommandName("skill:foo", ["foo", "bar"])).toBe(true);
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
		expect(list).toContain("`/skills`");
		expect(list).not.toContain("/model");
	});

	it("renders top-level help as one line per command, with a hint toward per-command detail", () => {
		const help = renderBuiltInHelp();
		expect(help).toContain("**斜杠命令**");
		expect(help).toContain("**传输层命令**");
		expect(help).toContain("**会话层命令**");
		expect(help).toContain("/help <命令名>");
		expect(help).toContain("`/followup`");
		expect(help).toContain("`/events`");
		expect(help).toContain("busyMessageDefault");
		expect(help).toContain("`/model`");
		expect(help).toContain("`/thinking`");
		expect(help).toContain("`/memory`");
		expect(help).toContain("`/skills`");
		// argument syntax and examples are per-command detail now, not in the top-level listing
		expect(help).not.toContain("/followup <消息>");
		expect(help).not.toContain("/model [provider/modelId|modelId]");
	});

	it("renders /help <name> per command and falls back to the top-level listing for unknown names", () => {
		expect(renderBuiltInHelp("tasks")).toContain("/tasks set <id> <wake|next|deadline> <值>");
		expect(renderBuiltInHelp("tasks")).toContain("/tasks doctor");
		expect(renderBuiltInHelp("steer")).toContain("/steer <消息>");
		expect(renderBuiltInHelp("steer")).toContain("示例：");
		expect(renderBuiltInHelp("model")).toContain("/model [provider/modelId|modelId]");

		const help = renderBuiltInHelp("bogus");
		expect(help).toContain("未找到命令 `/bogus`");
		expect(help).toContain("**斜杠命令**");
	});
});
