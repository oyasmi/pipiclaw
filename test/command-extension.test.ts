import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_RESULT_CUSTOM_TYPE, createCommandExtension } from "../src/command-extension.js";
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
			switchModel: vi.fn(async () => {}),
			refreshSessionResources: vi.fn(async () => {}),
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

function getLastCommandResult(api: FakeExtensionAPI): { customType: string; content: string; display: boolean } {
	return api.sentMessages[api.sentMessages.length - 1] as { customType: string; content: string; display: boolean };
}

describe("command-extension", () => {
	it("registers session/model/new/compact commands", () => {
		const api = new FakeExtensionAPI();
		createCommandExtension(createOptions().options)(api as never);

		expect([...api.registeredCommands.keys()]).toEqual(["session", "model", "new", "compact"]);
	});

	it("renders /session output with session stats and command custom type", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		createCommandExtension(options)(api as never);

		await api.registeredCommands.get("session")?.handler("", createCommandContext());

		expect(getLastCommandResult(api)).toMatchObject({
			customType: COMMAND_RESULT_CUSTOM_TYPE,
			display: true,
		});
		expect(getLastCommandResult(api).content).toContain("Session ID");
		expect(getLastCommandResult(api).content).toContain("gpt-4o-mini");
		expect(getLastCommandResult(api).content).toContain("Tokens");
	});

	it("shows current and available models when /model has no args", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		createCommandExtension(options)(api as never);

		await api.registeredCommands.get("model")?.handler("", createCommandContext());

		expect(getLastCommandResult(api).content).toContain("Current model");
		expect(getLastCommandResult(api).content).toContain("Available models");
		expect(getLastCommandResult(api).content).toContain("claude-sonnet-4-5");
	});

	it("switches model on exact match and reports ambiguity / missing models", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		options.getAvailableModels.mockResolvedValue([
			{ provider: "openai", id: "gpt-5-mini", name: "GPT-5 Mini" } as never,
			{ provider: "custom", id: "gpt-5-mini", name: "Custom GPT-5 Mini" } as never,
			{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" } as never,
		]);
		createCommandExtension(options)(api as never);

		await api.registeredCommands.get("model")?.handler("anthropic/claude-sonnet-4-5", createCommandContext());
		expect(options.switchModel).toHaveBeenCalledTimes(1);
		expect(getLastCommandResult(api).content).toContain("已切换模型");

		await api.registeredCommands.get("model")?.handler("gpt-5-mini", createCommandContext());
		expect(getLastCommandResult(api).content).toContain("匹配到多个模型");

		await api.registeredCommands.get("model")?.handler("missing-model", createCommandContext());
		expect(getLastCommandResult(api).content).toContain("未找到模型");
	});

	it("creates and cancels new sessions correctly", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		createCommandExtension(options)(api as never);
		const ctx = createCommandContext();

		await api.registeredCommands.get("new")?.handler("", ctx as never);
		expect(options.refreshSessionResources).toHaveBeenCalledTimes(1);
		expect(getLastCommandResult(api).content).toContain("sess_new");

		ctx.newSession.mockResolvedValueOnce({ cancelled: true });
		await api.registeredCommands.get("new")?.handler("", ctx as never);
		expect(getLastCommandResult(api).content).toContain("已取消");
	});

	it("runs manual compaction and forwards custom instructions", async () => {
		const api = new FakeExtensionAPI();
		const { options } = createOptions();
		createCommandExtension(options)(api as never);
		const ctx = createCommandContext();

		await api.registeredCommands.get("compact")?.handler("keep recent errors", ctx as never);

		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(getLastCommandResult(api).content).toContain("Tokens before compaction");
		expect(getLastCommandResult(api).content).toContain("summary:keep recent errors");
	});
});
