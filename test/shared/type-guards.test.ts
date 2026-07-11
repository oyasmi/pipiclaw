import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { isStandardAgentMessage } from "../../src/shared/type-guards.js";

describe("shared/type-guards", () => {
	it("accepts standard agent messages and rejects custom ones", () => {
		const userMessage = { role: "user", content: "hello" } as AgentMessage;
		const assistantMessage = { role: "assistant", content: [{ type: "text", text: "done" }] } as AgentMessage;
		const toolResultMessage = {
			role: "toolResult",
			toolCallId: "1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		} as AgentMessage;
		const customMessage = { role: "custom", content: "ignored" } as AgentMessage;

		expect(isStandardAgentMessage(userMessage)).toBe(true);
		expect(isStandardAgentMessage(assistantMessage)).toBe(true);
		expect(isStandardAgentMessage(toolResultMessage)).toBe(true);
		expect(isStandardAgentMessage(customMessage)).toBe(false);
	});
});
