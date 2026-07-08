import { describe, expect, it } from "vitest";
import { buildAppendSystemPrompt } from "../src/agent/prompt-builder.js";

describe("prompt-builder", () => {
	it("builds host runtime prompts with workspace and channel context", () => {
		const prompt = buildAppendSystemPrompt(
			"/workspace/root",
			"dm_123",
			{ type: "host" },
			{
				subAgentList: "- reviewer",
				tools: [
					{ name: "read", description: "Read files" },
					{ name: "web_search", description: "Search the web" },
					{ name: "web_fetch", description: "Fetch a URL" },
					{ name: "subagent", description: "Delegate" },
				],
			},
		);

		expect(prompt).toContain("## Pipiclaw Runtime");
		expect(prompt).toContain("You are running directly on the host machine.");
		expect(prompt).toContain("/workspace/root/dm_123");
		expect(prompt).toContain("ENVIRONMENT.md");
		expect(prompt).toContain("SESSION.md");
		expect(prompt).toContain("The runtime may inject a small amount of relevant memory context");
		expect(prompt).toContain("Available predefined sub-agents:\n- reviewer");
		// event_manage is not in this tool set → file-tool guidance, no stale "5 events" cap.
		expect(prompt).not.toContain("Maximum 5 events");
		expect(prompt).toContain("de-duplicates by filename");
		expect(prompt).toContain("web_search");
		expect(prompt).toContain("web_fetch");
		expect(prompt).toContain("return untrusted external content");
		expect(prompt).not.toContain("scratch/");
		expect(prompt).not.toContain("channel-specific tools");
	});

	it("advertises the event_manage scheduling path and its guards when the tool is present", () => {
		const prompt = buildAppendSystemPrompt(
			"/workspace/root",
			"dm_123",
			{ type: "host" },
			{ tools: [{ name: "event_manage", description: "Schedule events" }] },
		);

		expect(prompt).toContain("Prefer the event_manage tool");
		expect(prompt).toContain("no immediate events");
		expect(prompt).toContain("every 30 minutes (5 minutes when it carries a preAction gate)");
		expect(prompt).toContain("at most 50 event files");
		expect(prompt).not.toContain("Maximum 5 events");
	});

	it("builds docker runtime prompts with docker-specific instructions", () => {
		const prompt = buildAppendSystemPrompt(
			"/workspace/root",
			"group_456",
			{ type: "docker", container: "sandbox" },
			{ tools: [{ name: "subagent", description: "Delegate" }] },
		);

		expect(prompt).toContain("You are running inside a Docker container (Alpine Linux).");
		expect(prompt).toContain("Install tools with: apk add <package>");
		expect(prompt).toContain("Available predefined sub-agents: none");
		expect(prompt).toContain("prefer SESSION.md first for current state");
		expect(prompt).toContain("group_456");
	});

	it("renders only the tools actually registered, gating their instructions", () => {
		// A minimal set with no web tools, no session_search, no subagent.
		const prompt = buildAppendSystemPrompt(
			"/workspace/root",
			"dm_1",
			{ type: "host" },
			{
				tools: [
					{ name: "read", description: "Read files" },
					{ name: "bash", description: "Run shell commands" },
					{ name: "memory_save", description: "Save a durable fact" },
				],
			},
		);

		// Tools section lists exactly the registered tools.
		expect(prompt).toContain("- read:");
		expect(prompt).toContain("- bash:");
		expect(prompt).toContain("- memory_save:");
		expect(prompt).not.toContain("- web_search:");
		expect(prompt).not.toContain("- web_fetch:");
		expect(prompt).not.toContain("- session_search:");
		expect(prompt).not.toContain("- subagent:");

		// Tool-specific instructions follow the same source of truth.
		expect(prompt).toContain("call memory_save right away"); // memory_save present
		expect(prompt).not.toContain("return untrusted external content"); // web-safety gated
		expect(prompt).not.toContain("Use session_search only when"); // session_search gated
		expect(prompt).not.toContain("## Sub-Agents"); // subagent gated
	});

	it("advertises web and subagent instructions when those tools are registered", () => {
		const prompt = buildAppendSystemPrompt(
			"/workspace/root",
			"dm_2",
			{ type: "host" },
			{
				tools: [
					{ name: "read", description: "Read files" },
					{ name: "web_search", description: "Search the web" },
					{ name: "session_search", description: "Search transcripts" },
					{ name: "subagent", description: "Delegate" },
				],
			},
		);

		expect(prompt).toContain("- web_search:");
		expect(prompt).toContain("return untrusted external content");
		expect(prompt).toContain("Use session_search only when");
		expect(prompt).toContain("## Sub-Agents");
		// memory_save was not registered, so its instruction must be absent.
		expect(prompt).not.toContain("call memory_save right away");
	});

	it("falls back to a tool's own description for unknown tool names", () => {
		const prompt = buildAppendSystemPrompt(
			"/workspace/root",
			"dm_3",
			{ type: "host" },
			{
				tools: [{ name: "custom_tool", description: "Does a custom thing. More detail here." }],
			},
		);

		expect(prompt).toContain("- custom_tool: Does a custom thing.");
	});
});
