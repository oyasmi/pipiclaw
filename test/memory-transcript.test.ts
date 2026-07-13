import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { sanitizeMessagesForMemory, stripInjectedMemoryContext } from "../src/memory/transcript.js";

describe("stripInjectedMemoryContext", () => {
	it("removes runtime_context and unwraps user_message", () => {
		const raw = [
			"<runtime_context>",
			"Relevant context for this turn:",
			"[channel-memory/Constraints]",
			"- Keep prod online.",
			"</runtime_context>",
			"",
			"<user_message>",
			"重启一下服务",
			"</user_message>",
		].join("\n");

		expect(stripInjectedMemoryContext(raw)).toBe("重启一下服务");
	});

	it("removes the durable memory bootstrap block", () => {
		const raw = [
			"<durable_memory_snapshot>",
			"[Channel MEMORY.md]",
			"- Something durable.",
			"</durable_memory_snapshot>",
			"",
			"actual question",
		].join("\n");

		expect(stripInjectedMemoryContext(raw)).toBe("actual question");
	});

	it("leaves plain text untouched", () => {
		expect(stripInjectedMemoryContext("just a normal message")).toBe("just a normal message");
	});
});

describe("sanitizeMessagesForMemory", () => {
	it("strips injected context from user turns but keeps assistant turns", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: "<runtime_context>\nmemory\n</runtime_context>\n\n<user_message>\nhello\n</user_message>",
			},
			{ role: "assistant", content: [{ type: "text", text: "hi there" }] },
		] as unknown as AgentMessage[];

		const sanitized = sanitizeMessagesForMemory(messages);
		expect(sanitized[0]?.content).toBe("hello");
		expect(sanitized[1]).toEqual(messages[1]);
	});

	it("sanitizes text parts of multimodal user content", () => {
		const messages: AgentMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "<runtime_context>\nx\n</runtime_context>\n\n<user_message>\nsee image\n</user_message>",
					},
					{ type: "image", image: "data:..." },
				],
			},
		] as unknown as AgentMessage[];

		const sanitized = sanitizeMessagesForMemory(messages);
		const content = sanitized[0]?.content;
		expect(Array.isArray(content)).toBe(true);
		if (Array.isArray(content)) {
			expect(content[0]).toMatchObject({ type: "text", text: "see image" });
			expect(content[1]).toMatchObject({ type: "image" });
		}
	});

	it("drops tool results and redacts secrets before memory workers see them", () => {
		const messages = [
			{ role: "user", content: "remember api_key=supersecretvalue" },
			{ role: "toolResult", content: [{ type: "text", text: "sk-live-abcdefghijklmnop" }] },
			{ role: "assistant", content: [{ type: "text", text: "Bearer abcdefghijklmnop" }] },
		] as unknown as AgentMessage[];
		const serialized = JSON.stringify(sanitizeMessagesForMemory(messages));
		expect(serialized).not.toContain("supersecretvalue");
		expect(serialized).not.toContain("sk-live");
		expect(serialized).not.toContain("abcdefghijklmnop");
		expect(serialized).toContain("REDACTED_SECRET");
		expect(sanitizeMessagesForMemory(messages).some((message) => message.role === "toolResult")).toBe(false);
	});
});
