import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { renderMemoryBootstrap } from "../src/memory/render.js";
import { sanitizeMessagesForMemory, stripInjectedMemoryContext } from "../src/memory/transcript.js";

describe("stripInjectedMemoryContext", () => {
	it("removes every injected wrapper block (runtime_context, runtime_turn_context, durable_memory_snapshot, task_agenda) and unwraps user_message", () => {
		const injectedBlocks = [
			{
				tag: "runtime_context",
				body: "Relevant context for this turn:\n[channel-memory/Constraints]\n- Keep prod online.",
			},
			{ tag: "runtime_turn_context", body: "Relevant context for this turn only." },
			{ tag: "durable_memory_snapshot", body: "[Channel MEMORY.md]\n- Something durable." },
			{ tag: "task_agenda", body: "- Finish the migration." },
		];
		for (const { tag, body } of injectedBlocks) {
			const raw = [`<${tag}>`, body, `</${tag}>`, "", "<user_message>", "重启一下服务", "</user_message>"].join(
				"\n",
			);

			expect(stripInjectedMemoryContext(raw)).toBe("重启一下服务");
		}
	});

	// Regression: the wrapper `memory/render.ts` actually emits was missing from the list, so an
	// entire session's recalled memory reached the reflect pass dressed as fresh user input — and,
	// because the leftover block sat in front of `<user_message>`, the anchored unwrap failed too
	// and the runtime's own tags leaked with it.
	it("strips the memory bootstrap the renderer really produces, and still unwraps the user message", () => {
		const bootstrap = renderMemoryBootstrap({
			workspaceMemory: "- 用户偏好：保持简单。",
			channelIndex: "- [deploy-steps](deploy-steps.md) — 发布流程",
			journal: { date: "2026-09-06", text: "定了先修验收关闭。" },
		});
		const raw = [bootstrap, "", "<user_message>", "重启一下服务", "</user_message>"].join("\n");

		const stripped = stripInjectedMemoryContext(raw);
		expect(stripped).toBe("重启一下服务");
		expect(stripped).not.toContain("保持简单");
		expect(stripped).not.toContain("deploy-steps");
		expect(stripped).not.toContain("定了先修验收关闭");
	});
});

describe("sanitizeMessagesForMemory", () => {
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
