import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/session.js", () => ({
	updateChannelSessionMemory: vi.fn(),
}));

vi.mock("../src/memory/consolidation.js", () => ({
	runInlineConsolidation: vi.fn().mockResolvedValue({
		skipped: false,
		appendedMemoryEntries: 1,
		appendedHistoryBlock: true,
	}),
}));

vi.mock("../src/memory/review-log.js", () => ({
	appendMemoryReviewLog: vi.fn().mockResolvedValue(undefined),
}));

import { runInlineConsolidation } from "../src/memory/consolidation.js";
import { MemoryLifecycle } from "../src/memory/lifecycle.js";
import { updateChannelSessionMemory } from "../src/memory/session.js";

afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

async function waitForAssertion(assertion: () => void): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}
	throw lastError;
}

function createFakePi() {
	const handlers = new Map<string, (event: any) => Promise<void> | void>();
	return {
		api: {
			on(eventName: string, handler: (event: any) => Promise<void> | void) {
				handlers.set(eventName, handler);
			},
		},
		handlers,
	};
}

function createLifecycle(
	settings?: Partial<ReturnType<typeof createSettings>>,
	recordMemoryActivity?: ConstructorParameters<typeof MemoryLifecycle>[0]["recordMemoryActivity"],
) {
	return new MemoryLifecycle({
		channelId: "dm_123",
		channelDir: "/tmp/dm_123",
		getMessages: () => [{ role: "assistant", content: "live state" }] as never[],
		getSessionEntries: () => [],
		getModel: () => ({ provider: "test", id: "noop" }) as never,
		resolveApiKey: async () => "",
		getSessionMemorySettings: () => createSettings(settings),
		recordMemoryActivity,
	});
}

function createSettings(
	overrides: Partial<{
		enabled: boolean;
		minTurnsBetweenUpdate: number;
		minToolCallsBetweenUpdate: number;
		timeoutMs: number;
		failureBackoffTurns: number;
		forceRefreshBeforeCompact: boolean;
		forceRefreshBeforeNewSession: boolean;
	}> = {},
) {
	return {
		enabled: true,
		minTurnsBetweenUpdate: 2,
		minToolCallsBetweenUpdate: 4,
		timeoutMs: 30000,
		failureBackoffTurns: 3,
		forceRefreshBeforeCompact: true,
		forceRefreshBeforeNewSession: true,
		...overrides,
	};
}

describe("MemoryLifecycle", () => {
	it("waits for the forced compaction refresh before running inline consolidation", async () => {
		let resolveUpdate: (() => void) | undefined;
		vi.mocked(updateChannelSessionMemory).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveUpdate = () => resolve(undefined as never);
				}),
		);

		const compactionMessages = [{ role: "user", content: "summarize this" }] as never[];
		const lifecycle = createLifecycle();
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		const beforeCompact = fakePi.handlers.get("session_before_compact")?.({
			preparation: { messagesToSummarize: compactionMessages },
		});
		await waitForAssertion(() => {
			expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);
		});
		expect(runInlineConsolidation).not.toHaveBeenCalled();

		resolveUpdate?.();
		await expect(beforeCompact).resolves.toBeUndefined();
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		expect(runInlineConsolidation).toHaveBeenCalledWith(expect.objectContaining({ mode: "boundary" }));
		expect(vi.mocked(updateChannelSessionMemory)).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: compactionMessages,
				timeoutMs: 30000,
			}),
		);
	});

	it("waits for the forced new-session refresh before running inline consolidation", async () => {
		let resolveUpdate: (() => void) | undefined;
		vi.mocked(updateChannelSessionMemory).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveUpdate = () => resolve(undefined as never);
				}),
		);

		const liveMessages = [{ role: "assistant", content: "current state" }] as never[];
		const lifecycle = new MemoryLifecycle({
			channelId: "dm_123",
			channelDir: "/tmp/dm_123",
			getMessages: () => liveMessages,
			getSessionEntries: () => [],
			getModel: () => ({ provider: "test", id: "noop" }) as never,
			resolveApiKey: async () => "",
			getSessionMemorySettings: () => createSettings(),
		});
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		const beforeSwitch = fakePi.handlers.get("session_before_switch")?.({
			reason: "new",
		});
		await waitForAssertion(() => {
			expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);
		});
		expect(runInlineConsolidation).not.toHaveBeenCalled();

		resolveUpdate?.();
		await expect(beforeSwitch).resolves.toBeUndefined();
		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		expect(vi.mocked(updateChannelSessionMemory)).toHaveBeenCalledWith(
			expect.objectContaining({
				messages: liveMessages,
				timeoutMs: 30000,
			}),
		);
	});

	it("records assistant turns for scheduled maintenance without running threshold sidecars", async () => {
		const recordMemoryActivity = vi.fn();
		const lifecycle = createLifecycle(
			{
				minTurnsBetweenUpdate: 1,
				minToolCallsBetweenUpdate: 99,
				failureBackoffTurns: 2,
			},
			recordMemoryActivity,
		);

		lifecycle.noteCompletedAssistantTurn();
		lifecycle.noteCompletedAssistantTurn();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(recordMemoryActivity).toHaveBeenCalledTimes(2);
		expect(recordMemoryActivity).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "assistant-turn-completed", channelId: "dm_123" }),
		);
		expect(updateChannelSessionMemory).not.toHaveBeenCalled();
		expect(runInlineConsolidation).not.toHaveBeenCalled();
	});

	it("does not run delayed memory sidecars after a normal assistant turn", async () => {
		vi.useFakeTimers();
		const lifecycle = createLifecycle({
			minTurnsBetweenUpdate: 99,
			minToolCallsBetweenUpdate: 99,
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});

		lifecycle.noteCompletedAssistantTurn();

		await vi.advanceTimersByTimeAsync(59_000);
		expect(runInlineConsolidation).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1_000);
		vi.useRealTimers();

		expect(runInlineConsolidation).not.toHaveBeenCalled();
	});

	it("flushes pending durable memory during shutdown", async () => {
		const lifecycle = createLifecycle({
			minTurnsBetweenUpdate: 99,
			minToolCallsBetweenUpdate: 99,
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});

		lifecycle.noteCompletedAssistantTurn();

		await lifecycle.flushForShutdown();

		expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
	});

	it("skips shutdown flush when there is no pending assistant snapshot", async () => {
		const lifecycle = createLifecycle({
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});

		await lifecycle.flushForShutdown();

		expect(runInlineConsolidation).not.toHaveBeenCalled();
	});

	it("records boundary events after compaction and new-session starts without running maintenance", async () => {
		const recordMemoryActivity = vi.fn();
		const lifecycle = createLifecycle(
			{
				forceRefreshBeforeCompact: false,
				forceRefreshBeforeNewSession: false,
			},
			recordMemoryActivity,
		);
		const fakePi = createFakePi();
		lifecycle.createExtensionFactory()(fakePi.api as never);

		fakePi.handlers.get("session_compact")?.({});
		fakePi.handlers.get("session_start")?.({ reason: "new" });

		expect(recordMemoryActivity).toHaveBeenCalledTimes(2);
		expect(recordMemoryActivity).toHaveBeenCalledWith(expect.objectContaining({ kind: "boundary" }));
	});
});
