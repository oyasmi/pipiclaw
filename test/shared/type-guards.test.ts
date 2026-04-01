import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildStandardMessages, isRecord, isStandardAgentMessage } from "../../src/shared/type-guards.js";

describe("shared/type-guards", () => {
	it("detects plain records", () => {
		expect(isRecord({ key: "value" })).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("text")).toBe(false);
	});

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

	it("filters agent messages down to standard conversation messages", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: [{ type: "text", text: "world" }] },
			{ role: "custom", content: "ignored" },
			{
				role: "toolResult",
				toolCallId: "1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: Date.now(),
			},
		] as AgentMessage[];

		expect(buildStandardMessages(messages)).toHaveLength(3);
		expect(buildStandardMessages(messages).map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
		]);
	});
});
