import { describe, expect, it } from "vitest";
import { buildAppendSystemPrompt } from "../src/prompt-builder.js";

describe("prompt-builder", () => {
	it("builds host runtime prompts with workspace and channel context", () => {
		const prompt = buildAppendSystemPrompt(
			"/workspace/root",
			"dm_123",
			{ type: "host" },
			{ subAgentList: "- reviewer" },
		);

		expect(prompt).toContain("## Pipiclaw Runtime");
		expect(prompt).toContain("You are running directly on the host machine.");
		expect(prompt).toContain("/workspace/root/dm_123");
		expect(prompt).toContain("Available predefined sub-agents:\n- reviewer");
		expect(prompt).toContain("Maximum 5 events can be queued.");
	});

	it("builds docker runtime prompts with docker-specific instructions", () => {
		const prompt = buildAppendSystemPrompt("/workspace/root", "group_456", { type: "docker", container: "sandbox" });

		expect(prompt).toContain("You are running inside a Docker container (Alpine Linux).");
		expect(prompt).toContain("Install tools with: apk add <package>");
		expect(prompt).toContain("Available predefined sub-agents: none");
		expect(prompt).toContain("group_456");
	});
});
