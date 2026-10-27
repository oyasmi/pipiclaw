import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { createCommandExtension } from "../src/agent/session/command-extension.js";
import { FakeExtensionAPI } from "./helpers/fake-extension-api.js";

function createOptions() {
	const currentModel = { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o Mini" } as never;
	return {
		currentModel,
		options: {
			getCurrentModel: vi.fn(() => currentModel),
			getAvailableModels: vi.fn(async () => [
				currentModel,
				{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as never,
				{ provider: "openai", id: "gpt-5-mini", name: "GPT-5 Mini" } as never,
			]),
			getSessionStats: vi.fn(() => ({
				sessionId: "sess_123",
				sessionFile: "/tmp/session-1.jsonl",
				userMessages: 1,
				assistantMessages: 2,
				toolCalls: 3,
				toolResults: 3,
				totalMessages: 9,
				tokens: { total: 100, input: 60, output: 30, cacheRead: 5, cacheWrite: 5 },
				cost: 1.2345,
			})),
			getThinkingLevel: vi.fn(() => "off" as ThinkingLevel),
			getAvailableThinkingLevels: vi.fn(() => ["off", "minimal", "low", "medium", "high"] as ThinkingLevel[]),
			setThinkingLevel: vi.fn(),
			cycleThinkingLevel: vi.fn(() => "medium" as ThinkingLevel),
			switchModel: vi.fn(async () => {}),
			refreshSessionResources: vi.fn(async () => {}),
			runMemoryCommand: vi.fn(async () => "# Memory Status"),
		},
	};
}

function createCommandContext() {
	return {
		newSession: vi.fn(async () => ({ cancelled: false })),
		compact: vi.fn(
			({ onComplete, customInstructions }: { onComplete: (result: unknown) => void; customInstructions?: string }) =>
				onComplete({
					tokensBefore: 1234,
					summary: customInstructions ? `summary:${customInstructions}` : "summary",
				}),
		),
		sessionManager: {
			getSessionId: vi.fn(() => "sess_new"),
		},
	};
}

describe("command-extension", () => {
	it("shows, sets, cycles, and validates thinking levels", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		createCommandExtension(options)(api as never);

		await api.registeredCommands.get("thinking")?.handler("", createCommandContext());

		await api.registeredCommands.get("thinking")?.handler("high", createCommandContext());
		expect(options.setThinkingLevel).toHaveBeenCalledWith("high");

		await api.registeredCommands.get("thinking")?.handler("cycle", createCommandContext());
		expect(options.cycleThinkingLevel).toHaveBeenCalledTimes(1);

		await api.registeredCommands.get("thinking")?.handler("max", createCommandContext());
		expect(options.setThinkingLevel).toHaveBeenCalledTimes(1);
	});

	it("switches model on exact or unique substring match and reports ambiguity / missing models", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		options.getAvailableModels.mockResolvedValue([
			{ provider: "bailian", id: "glm-5", name: "GLM 5" } as never,
			{ provider: "bailian", id: "qwen3-max-2026-01-23", name: "Qwen 3 Max" } as never,
			{ provider: "bailian", id: "kimi-k2.5", name: "Kimi K2.5" } as never,
			{ provider: "zpai", id: "glm-5-turbo", name: "GLM 5 Turbo" } as never,
			{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as never,
		]);
		createCommandExtension(options)(api as never);

		await api.registeredCommands.get("model")?.handler("", createCommandContext());
		expect(options.getAvailableModels).toHaveBeenCalled();
		await api.registeredCommands.get("model")?.handler("anthropic/claude-sonnet-4-5", createCommandContext());
		expect(options.switchModel).toHaveBeenCalledTimes(1);
		expect(options.switchModel).toHaveBeenLastCalledWith(
			expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
		);

		await api.registeredCommands.get("model")?.handler("turbo", createCommandContext());
		expect(options.switchModel).toHaveBeenCalledTimes(2);
		expect(options.switchModel).toHaveBeenLastCalledWith(
			expect.objectContaining({ provider: "zpai", id: "glm-5-turbo" }),
		);

		await api.registeredCommands.get("model")?.handler("qwen", createCommandContext());
		expect(options.switchModel).toHaveBeenCalledTimes(3);
		expect(options.switchModel).toHaveBeenLastCalledWith(
			expect.objectContaining({ provider: "bailian", id: "qwen3-max-2026-01-23" }),
		);

		await api.registeredCommands.get("model")?.handler("glm", createCommandContext());

		await api.registeredCommands.get("model")?.handler("missing-model", createCommandContext());
		expect(options.switchModel).toHaveBeenCalledTimes(3);
	});

	it("reloads resources and creates or cancels new sessions correctly", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		createCommandExtension(options)(api as never);
		const ctx = createCommandContext();
		ctx.sessionManager.getSessionId.mockReturnValueOnce("sess_first").mockReturnValueOnce("sess_second");
		await api.registeredCommands.get("reload")?.handler("", ctx as never);
		expect(options.refreshSessionResources).toHaveBeenCalledTimes(1);
		await api.registeredCommands.get("reload")?.handler("unexpected", ctx as never);
		expect(options.refreshSessionResources).toHaveBeenCalledTimes(1);

		await api.registeredCommands.get("new")?.handler("", ctx as never);

		await api.registeredCommands.get("new")?.handler("", ctx as never);
		expect(options.refreshSessionResources).toHaveBeenCalledTimes(3);

		ctx.newSession.mockResolvedValueOnce({ cancelled: true });
		await api.registeredCommands.get("new")?.handler("", ctx as never);
		expect(options.refreshSessionResources).toHaveBeenCalledTimes(3);
	});

	it("runs manual compaction and forwards custom instructions", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		createCommandExtension(options)(api as never);
		const ctx = createCommandContext();

		await api.registeredCommands.get("compact")?.handler("keep recent errors", ctx as never);

		// Custom instructions must reach the compactor.
		expect(ctx.compact).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ customInstructions: "keep recent errors" }),
		);
	});
});
