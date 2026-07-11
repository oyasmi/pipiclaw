import { describe, expect, it } from "vitest";
import { buildAppendSystemPrompt } from "../src/agent/prompt-builder.js";
import { PLAYBOOKS_DIR } from "../src/paths.js";

describe("prompt-builder", () => {
	it("keeps runtime ownership and progressive-loading rules always on", () => {
		const prompt = buildAppendSystemPrompt("/workspace/root", "dm_123", { tools: [] });
		expect(prompt).toContain("## Knowledge and State Layers");
		expect(prompt).toContain("Runtime playbooks under");
		expect(prompt).toContain(PLAYBOOKS_DIR);
		expect(prompt).toContain("must not redefine runtime facts or hard gates");
		expect(prompt).toContain("SESSION → MEMORY → HISTORY");
		expect(prompt).toContain("Never edit channel SESSION.md, MEMORY.md, or HISTORY.md");
		expect(prompt).toContain("## Runtime Playbooks");
		expect(prompt).toContain("runtime-orientation.md");
		expect(prompt).not.toContain("## Events");
		expect(prompt).not.toContain("## Environment Log");
	});

	it("renders only registered tools and their minimal hard invariants", () => {
		const prompt = buildAppendSystemPrompt("/workspace/root", "dm_1", {
			tools: [
				{ name: "read", description: "Read files" },
				{ name: "memory_manage", description: "Save memory" },
			],
		});
		expect(prompt).toContain("- read:");
		expect(prompt).toContain("- memory_manage:");
		expect(prompt).not.toContain("- task_manage:");
		expect(prompt).toContain("use memory_manage immediately");
		expect(prompt).not.toContain("## Persistent Task Core");
	});

	it("keeps only the task recovery core and routes details to playbooks", () => {
		const prompt = buildAppendSystemPrompt("/workspace/root", "dm_123", {
			tools: [{ name: "task_manage", description: "Manage tasks" }],
		});
		expect(prompt).toContain("## Persistent Task Core");
		expect(prompt).toContain("open the exact named `tasks/<id>.md`");
		expect(prompt).toContain("does not end with candidate, done, cancel, or start-cycle");
		expect(prompt).toContain("use task_manage set only for non-body waiting metadata");
		expect(prompt).toContain("task-closeout.md");
		expect(prompt).not.toContain("control.parent and control.dependsOn");
		expect(prompt).not.toContain("purpose=verify and taskId");
	});

	it("keeps dynamic sub-agent discovery while routing operating detail", () => {
		const prompt = buildAppendSystemPrompt("/workspace/root", "dm_2", {
			subAgentList: "- reviewer",
			tools: [{ name: "subagent", description: "Delegate" }],
		});
		expect(prompt).toContain("## Available Predefined Sub-Agents");
		expect(prompt).toContain("- reviewer");
		expect(prompt).toContain("Read task-delegation.md");
		expect(prompt).not.toContain("Temporary Inline Sub-Agents");
	});

	it("falls back to a tool's first description sentence", () => {
		const prompt = buildAppendSystemPrompt("/workspace/root", "dm_3", {
			tools: [{ name: "custom_tool", description: "Does a custom thing. More detail here." }],
		});
		expect(prompt).toContain("- custom_tool: Does a custom thing.");
	});

	it("is materially smaller than the pre-playbook-detail prompt", () => {
		const names = [
			"read",
			"write",
			"edit",
			"bash",
			"grep",
			"job",
			"memory_manage",
			"session_search",
			"skill_manage",
			"event_manage",
			"task_manage",
			"subagent",
			"web_search",
			"web_fetch",
		];
		const prompt = buildAppendSystemPrompt("/workspace/root", "dm_123", {
			tools: names.map((name) => ({ name, description: name })),
		});
		expect(prompt.length).toBeLessThan(9_000);
	});
});
