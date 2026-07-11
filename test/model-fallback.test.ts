import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModel as getModel } from "@earendil-works/pi-ai/providers/all";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FallbackRunDeps,
	PRIMARY_COOLDOWN_MS,
	runPromptWithFallback,
	shouldFallback,
	shouldRestorePrimary,
	summarizeFallbackError,
	takeFailedTurn,
} from "../src/agent/model-fallback.js";

const primaryModel = getModel("anthropic", "claude-sonnet-4-5");
const backupModel = getModel("openai", "gpt-4o-mini");
if (!primaryModel || !backupModel) {
	throw new Error("Expected built-in models to exist for tests");
}

const userMsg = { role: "user", content: "hi" };
const assistantError = { role: "assistant", stopReason: "error", errorMessage: "429 Too Many Requests", content: [] };

describe("shouldFallback", () => {
	it.each([
		["429 rate limit exceeded", true],
		["503 Service Unavailable", true],
		[undefined, true],
	])("returns %s → %s for provider errors", (message, expected) => {
		expect(shouldFallback(message as string | undefined)).toBe(expected);
	});

	it.each([
		"prompt is too long: 213462 tokens > 200000 maximum",
		"This model's maximum prompt length is 131072 but the request contains 537812 tokens",
		"input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
	])("returns false for context overflow: %s", (message) => {
		expect(shouldFallback(message)).toBe(false);
	});

	it("treats a rate-limit worded 'too many tokens' as fallback, not overflow", () => {
		expect(shouldFallback("ThrottlingException: Too many requests, please wait")).toBe(true);
	});
});

describe("takeFailedTurn", () => {
	it("removes [user, assistant(error)] tail", () => {
		const messages = [{ role: "assistant", stopReason: "stop" }, userMsg, assistantError];
		const result = takeFailedTurn(messages);
		expect(result).toEqual([{ role: "assistant", stopReason: "stop" }]);
	});

	it("returns null for any non-[user, assistant(error)] tail", () => {
		expect(takeFailedTurn([userMsg, { role: "assistant", stopReason: "stop" }])).toBeNull();
		const toolResult = { role: "toolResult" };
		expect(takeFailedTurn([userMsg, toolResult, assistantError])).toBeNull();
	});

	it("returns null for fewer than two messages", () => {
		expect(takeFailedTurn([assistantError])).toBeNull();
		expect(takeFailedTurn([])).toBeNull();
	});
});

describe("shouldRestorePrimary", () => {
	it("returns true when never failed", () => {
		expect(shouldRestorePrimary(null, Date.now())).toBe(true);
	});

	it("returns false within the cooldown window", () => {
		const now = 1_000_000;
		expect(shouldRestorePrimary(now - PRIMARY_COOLDOWN_MS + 1, now)).toBe(false);
	});

	it("returns true after the cooldown elapses", () => {
		const now = 1_000_000;
		expect(shouldRestorePrimary(now - PRIMARY_COOLDOWN_MS - 1, now)).toBe(true);
	});
});

describe("summarizeFallbackError", () => {
	it("takes the first line and caps length", () => {
		expect(summarizeFallbackError("429 rate limit\nmore detail")).toBe("429 rate limit");
		expect(summarizeFallbackError(undefined)).toBe("未知错误");
		expect(summarizeFallbackError("x".repeat(200))).toHaveLength(120);
	});
});

interface FakeState {
	messages: unknown[];
	stopReason: string;
	errorMessage?: string;
	currentModel: Model<Api>;
	promptSubmitted: boolean;
	primaryFailedAt: number | null;
	switches: string[];
	promptCalls: string[];
	notices: Array<{ from: string; to: string; summary: string }>;
}

/**
 * Build deps over a fake state. `promptOutcomes` is consumed one per prompt() call:
 * each entry decides what terminal state that prompt lands in.
 */
function makeDeps(
	state: FakeState,
	backup: Model<Api> | null,
	promptOutcomes: Array<{
		stopReason: string;
		errorMessage?: string;
		submitted?: boolean;
		appendFailedTurn?: boolean;
	}>,
): FallbackRunDeps {
	let call = 0;
	return {
		prompt: async (text) => {
			state.promptCalls.push(text);
			const outcome = promptOutcomes[call++] ?? { stopReason: "stop" };
			state.stopReason = outcome.stopReason;
			state.errorMessage = outcome.errorMessage;
			state.promptSubmitted = outcome.submitted ?? true;
			if (outcome.appendFailedTurn) {
				state.messages.push(userMsg, {
					role: "assistant",
					stopReason: "error",
					errorMessage: outcome.errorMessage,
				});
			}
		},
		getRunError: () => ({ stopReason: state.stopReason, errorMessage: state.errorMessage }),
		resetRunError: () => {
			state.stopReason = "stop";
			state.errorMessage = undefined;
		},
		getMessages: () => state.messages,
		setMessages: (messages) => {
			state.messages = messages;
		},
		promptWasSubmitted: () => state.promptSubmitted,
		getCurrentModelRef: () => `${state.currentModel.provider}/${state.currentModel.id}`,
		resolveFallbackModel: async () => backup,
		setModel: async (model) => {
			state.currentModel = model;
			state.switches.push(`${model.provider}/${model.id}`);
		},
		notifySwitch: (from, to, summary) => {
			state.notices.push({ from, to, summary });
		},
		markPrimaryFailed: () => {
			state.primaryFailedAt = 12345;
		},
	};
}

function freshState(): FakeState {
	return {
		messages: [],
		stopReason: "stop",
		errorMessage: undefined,
		currentModel: primaryModel as Model<Api>,
		promptSubmitted: false,
		primaryFailedAt: null,
		switches: [],
		promptCalls: [],
		notices: [],
	};
}

describe("runPromptWithFallback", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("does a single prompt when the first attempt succeeds", async () => {
		const state = freshState();
		const deps = makeDeps(state, backupModel as Model<Api>, [{ stopReason: "stop" }]);
		const attempted = await runPromptWithFallback("do it", deps);
		expect(attempted).toBe(false);
		expect(state.promptCalls).toEqual(["do it"]);
		expect(state.switches).toEqual([]);
	});

	it("switches to backup and re-runs the same prompt on error", async () => {
		const state = freshState();
		state.messages = [{ role: "assistant", stopReason: "stop" }];
		const deps = makeDeps(state, backupModel as Model<Api>, [
			{ stopReason: "error", errorMessage: "429", submitted: true, appendFailedTurn: true },
			{ stopReason: "stop" },
		]);
		const attempted = await runPromptWithFallback("do it", deps);
		expect(attempted).toBe(true);
		// Surgery removed the failed [user, assistant(error)] tail.
		expect(state.messages).toEqual([{ role: "assistant", stopReason: "stop" }]);
		expect(state.primaryFailedAt).toBe(12345);
		expect(state.switches).toEqual(["openai/gpt-4o-mini"]);
		expect(state.notices).toHaveLength(1);
		expect(state.promptCalls).toEqual(["do it", "do it"]);
	});

	it("does not fall back on context overflow", async () => {
		const state = freshState();
		const deps = makeDeps(state, backupModel as Model<Api>, [
			{ stopReason: "error", errorMessage: "prompt is too long: 999 tokens > 200 maximum", submitted: true },
		]);
		expect(await runPromptWithFallback("do it", deps)).toBe(false);
		expect(state.switches).toEqual([]);
	});

	it("does not fall back on abort", async () => {
		const state = freshState();
		const deps = makeDeps(state, backupModel as Model<Api>, [{ stopReason: "aborted" }]);
		expect(await runPromptWithFallback("do it", deps)).toBe(false);
		expect(state.switches).toEqual([]);
	});

	it("does not fall back when no backup model is configured", async () => {
		const state = freshState();
		const deps = makeDeps(state, null, [{ stopReason: "error", errorMessage: "429", submitted: true }]);
		expect(await runPromptWithFallback("do it", deps)).toBe(false);
		expect(state.promptCalls).toEqual(["do it"]);
	});

	it("does not fall back when the backup equals the current model", async () => {
		const state = freshState();
		const deps = makeDeps(state, primaryModel as Model<Api>, [
			{ stopReason: "error", errorMessage: "429", submitted: true },
		]);
		expect(await runPromptWithFallback("do it", deps)).toBe(false);
		expect(state.switches).toEqual([]);
	});

	it("skips fallback (no switch) when surgery finds an unexpected tail", async () => {
		const state = freshState();
		// Submitted, but tail is not [user, assistant(error)] — e.g. a mid-turn multi-step failure.
		state.messages = [{ role: "toolResult" }, { role: "assistant", stopReason: "error" }];
		const deps = makeDeps(state, backupModel as Model<Api>, [
			{ stopReason: "error", errorMessage: "429", submitted: true },
		]);
		expect(await runPromptWithFallback("do it", deps)).toBe(false);
		expect(state.switches).toEqual([]);
	});

	it("switches without surgery when the first prompt was not submitted (pre-flight throw)", async () => {
		const state = freshState();
		const deps = makeDeps(state, backupModel as Model<Api>, [
			{ stopReason: "error", errorMessage: "No API key found for provider: anthropic", submitted: false },
			{ stopReason: "stop" },
		]);
		const attempted = await runPromptWithFallback("do it", deps);
		expect(attempted).toBe(true);
		expect(state.switches).toEqual(["openai/gpt-4o-mini"]);
		expect(state.promptCalls).toEqual(["do it", "do it"]);
	});

	it("returns true but only prompts twice when the backup also fails", async () => {
		const state = freshState();
		state.messages = [];
		const deps = makeDeps(state, backupModel as Model<Api>, [
			{ stopReason: "error", errorMessage: "429", submitted: true, appendFailedTurn: true },
			{ stopReason: "error", errorMessage: "500", submitted: true, appendFailedTurn: true },
		]);
		const attempted = await runPromptWithFallback("do it", deps);
		expect(attempted).toBe(true);
		expect(state.promptCalls).toHaveLength(2);
		expect(state.switches).toEqual(["openai/gpt-4o-mini"]);
	});
});
