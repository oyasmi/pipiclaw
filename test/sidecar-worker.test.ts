import { afterEach, describe, expect, it, vi } from "vitest";

let promptImpl = vi.fn<(input: string) => Promise<void>>(async () => {});
let waitForIdleImpl = vi.fn<() => Promise<void>>(async () => {});
let abortImpl = vi.fn<() => void>();
let stateMessages: unknown[] = [];
const recordUsage = vi.fn();

vi.mock("@earendil-works/pi-agent-core", () => ({
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

vi.mock("@earendil-works/pi-coding-agent", () => ({
	convertToLlm: vi.fn(),
}));

vi.mock("../src/usage/ledger.js", () => ({
	getUsageLedger: () => ({ record: recordUsage }),
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

	it("records the memory correlation id with sidecar cost", async () => {
		stateMessages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				stopReason: "stop",
				usage: {
					input: 10,
					output: 2,
					total: 12,
					cost: { input: 0.01, output: 0.02, total: 0.03 },
				},
			},
		];

		await runSidecarTask({
			name: "memory-inline-consolidation",
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
			systemPrompt: "System",
			prompt: "Prompt",
			parse: (text) => text,
			usageContext: { channelId: "dm_1", correlationId: "window-123" },
		});

		expect(recordUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: "dm_1",
				kind: "sidecar",
				label: "memory-inline-consolidation",
				correlationId: "window-123",
				cost: expect.objectContaining({ total: 0.03 }),
			}),
		);
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

	it("repairs a parse failure once when a repair hint is supplied", async () => {
		vi.useFakeTimers();
		const seenPrompts: string[] = [];
		promptImpl = vi.fn<(input: string) => Promise<void>>(async (input) => {
			seenPrompts.push(input);
		});
		stateMessages = [
			{
				role: "assistant",
				content: [{ type: "text", text: '{"rationation":"oops"}' }],
				stopReason: "stop",
			},
		];
		let parseCalls = 0;

		const taskPromise = runRetriedSidecarTask({
			name: "repair-task",
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
			systemPrompt: "System",
			prompt: "Prompt",
			parse: (text) => {
				parseCalls += 1;
				if (parseCalls === 1) {
					// The model fixes its output on the correction pass.
					stateMessages = [
						{ role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], stopReason: "stop" },
					];
					throw new Error("missing rationale key");
				}
				return text;
			},
			repair: () => "Return a JSON object with a 'rationale' key.",
		});

		await vi.advanceTimersByTimeAsync(2_000);
		await expect(taskPromise).resolves.toMatchObject({ output: '{"ok":true}' });
		expect(parseCalls).toBe(2);
		expect(seenPrompts).toHaveLength(2);
		expect(seenPrompts[0]).toBe("Prompt");
		expect(seenPrompts[1]).toBe("Prompt\n\nReturn a JSON object with a 'rationale' key.");
		vi.useRealTimers();
	});

	it("does not apply a repair hint more than once", async () => {
		vi.useFakeTimers();
		stateMessages = [{ role: "assistant", content: [{ type: "text", text: "bad" }], stopReason: "stop" }];
		let parseCalls = 0;

		const taskPromise = runRetriedSidecarTask({
			name: "repair-once-task",
			model: { provider: "test", id: "noop" } as never,
			resolveApiKey: async () => "",
			systemPrompt: "System",
			prompt: "Prompt",
			parse: () => {
				parseCalls += 1;
				throw new Error("always bad");
			},
			repair: () => "fix it",
		});
		// Attach a handler synchronously: the second attempt rejects during the
		// fake-timer flush, before `expect().rejects` would otherwise attach one.
		const outcome = taskPromise.then(
			(result) => ({ ok: true as const, result }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		await vi.advanceTimersByTimeAsync(2_000);
		const result = await outcome;
		if (result.ok) throw new Error("expected the task to fail after a single repair attempt");
		expect(result.error).toBeInstanceOf(Error);
		expect(parseCalls).toBe(2);
		vi.useRealTimers();
	});
});
