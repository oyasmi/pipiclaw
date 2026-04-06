import { afterEach, describe, expect, it, vi } from "vitest";

let promptImpl = vi.fn<(input: string) => Promise<void>>(async () => {});
let waitForIdleImpl = vi.fn<() => Promise<void>>(async () => {});
let abortImpl = vi.fn<() => void>();
let stateMessages: unknown[] = [];

vi.mock("@mariozechner/pi-agent-core", () => ({
	Agent: vi.fn().mockImplementation(() => ({
		state: {
			get messages() {
				return stateMessages;
			},
		},
		prompt: (input: string) => promptImpl(input),
		waitForIdle: () => waitForIdleImpl(),
		abort: () => abortImpl(),
	})),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
	convertToLlm: vi.fn(),
}));

import {
	runRetriedSidecarTask,
	runSidecarTask,
	type SidecarParseError,
	SidecarTimeoutError,
} from "../src/memory/sidecar-worker.js";

afterEach(() => {
	promptImpl = vi.fn<(input: string) => Promise<void>>(async () => {});
	waitForIdleImpl = vi.fn<() => Promise<void>>(async () => {});
	abortImpl = vi.fn<() => void>();
	stateMessages = [];
	vi.clearAllMocks();
});

describe("sidecar-worker", () => {
	it("aborts and times out long-running tasks", async () => {
		waitForIdleImpl = vi.fn(() => new Promise<void>(() => {}));

		await expect(
			runSidecarTask({
				name: "slow-task",
				model: { provider: "test", id: "noop" } as never,
				resolveApiKey: async () => "",
				systemPrompt: "System",
				prompt: "Prompt",
				parse: (text) => text,
				timeoutMs: 10,
			}),
		).rejects.toBeInstanceOf(SidecarTimeoutError);

		expect(abortImpl).toHaveBeenCalledTimes(1);
	});

	it("wraps parser failures with raw text context", async () => {
		stateMessages = [
			{
				role: "assistant",
				content: [{ type: "text", text: '{"ok":true}' }],
				stopReason: "stop",
			},
		];

		await expect(
			runSidecarTask({
				name: "bad-parse",
				model: { provider: "test", id: "noop" } as never,
				resolveApiKey: async () => "",
				systemPrompt: "System",
				prompt: "Prompt",
				parse: () => {
					throw new Error("boom");
				},
			}),
		).rejects.toMatchObject({
			name: "SidecarParseError",
			rawText: '{"ok":true}',
		} satisfies Partial<SidecarParseError>);
	});

	it("retries once after a transient sidecar failure", async () => {
		vi.useFakeTimers();
		promptImpl = vi
			.fn<(input: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error("transient upstream error"))
			.mockResolvedValueOnce(undefined);
		stateMessages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
			},
		];

		const taskPromise = runRetriedSidecarTask({
			name: "retry-task",
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
			systemPrompt: "System",
			prompt: "Prompt",
			parse: (text) => text,
		});

		await vi.advanceTimersByTimeAsync(2_000);
		await expect(taskPromise).resolves.toMatchObject({
			rawText: "ok",
			output: "ok",
		});
		expect(promptImpl).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it("does not retry parse failures", async () => {
		stateMessages = [
			{
				role: "assistant",
				content: [{ type: "text", text: '{"ok":true}' }],
				stopReason: "stop",
			},
		];

		await expect(
			runRetriedSidecarTask({
				name: "no-retry-parse",
				model: { provider: "test", id: "noop" } as never,
				resolveApiKey: async () => "",
				systemPrompt: "System",
				prompt: "Prompt",
				parse: () => {
					throw new Error("boom");
				},
			}),
		).rejects.toBeInstanceOf(Error);

		expect(promptImpl).toHaveBeenCalledTimes(1);
	});

	it("does not retry when the caller aborts during the retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		promptImpl = vi.fn<(input: string) => Promise<void>>().mockRejectedValue(new Error("transient upstream error"));

		const taskPromise = runRetriedSidecarTask({
			name: "abort-retry-task",
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
			systemPrompt: "System",
			prompt: "Prompt",
			parse: (text) => text,
			signal: controller.signal,
		});
		const rejection = expect(taskPromise).rejects.toThrow("caller aborted");

		await Promise.resolve();
		controller.abort(new Error("caller aborted"));
		await vi.runAllTimersAsync();
		await rejection;
		expect(promptImpl).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});
