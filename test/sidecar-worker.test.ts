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

import { runSidecarTask, type SidecarParseError, SidecarTimeoutError } from "../src/sidecar-worker.js";

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
});
