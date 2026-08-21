import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/memory/session.js", () => ({
	updateChannelSessionMemory: vi.fn(),
}));

vi.mock("../src/memory/consolidation.js", () => ({
	runInlineConsolidation: vi.fn().mockResolvedValue({
		skipped: false,
		appendedMemoryEntries: 1,
		appendedDurableEntries: 1,
		appendedProbationaryEntries: 0,
		appendedHistoryBlock: true,
		rejectedMemoryOps: [],
	}),
}));

vi.mock("../src/memory/review-log.js", () => ({
	appendMemoryReviewLog: vi.fn().mockResolvedValue(undefined),
}));

import { runInlineConsolidation } from "../src/memory/consolidation.js";
import { boundCompactionMessages, MemoryLifecycle } from "../src/memory/lifecycle.js";
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
		forceRefreshBeforeCompact: boolean;
		forceRefreshBeforeNewSession: boolean;
	}> = {},
) {
	return {
		enabled: true,
		minTurnsBetweenUpdate: 2,
		minToolCallsBetweenUpdate: 4,
		timeoutMs: 30000,
		forceRefreshBeforeCompact: true,
		forceRefreshBeforeNewSession: true,
		...overrides,
	};
}

describe("MemoryLifecycle", () => {
	it("bounds an oversized compaction request while retaining its head and tail", () => {
		const head = "ORIGINAL_GOAL ";
		const middle = "中".repeat(20_000);
		const tail = " CURRENT_STATE";
		const result = boundCompactionMessages(
			[{ role: "user", content: `${head}${middle}${tail}`, timestamp: Date.now() }] as never[],
			16_000,
			4_000,
		);

		expect(result.truncated).toBe(true);
		expect(result.boundedChars).toBeLessThan(result.originalChars);
		expect(result.messages).toHaveLength(1);
		const boundedText = (result.messages[0] as { content: Array<{ text: string }> }).content[0]?.text ?? "";
		expect(boundedText).toContain("ORIGINAL_GOAL");
		expect(boundedText).toContain("CURRENT_STATE");
		expect(boundedText).toContain("middle omitted");
	});

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

	it("returns immediately from new-session switch and consolidates in the background", async () => {
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

		// The handler must not block on the LLM-backed refresh/consolidation: it
		// returns synchronously so /new can create the new session immediately.
		const beforeSwitch = fakePi.handlers.get("session_before_switch")?.({
			reason: "new",
		});
		expect(beforeSwitch).toBeUndefined();

		// The refresh runs in the background against a snapshot of the outgoing
		// session, before the (still-pending) inline consolidation.
		await waitForAssertion(() => {
			expect(updateChannelSessionMemory).toHaveBeenCalledTimes(1);
		});
		expect(runInlineConsolidation).not.toHaveBeenCalled();

		resolveUpdate?.();
		await lifecycle.whenNewSessionConsolidationSettled();
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

	it.each([
		{
			label: "flushes pending durable memory from a completed assistant turn",
			activity: (lifecycle: MemoryLifecycle) => lifecycle.noteCompletedAssistantTurn(),
			expectedFlush: true,
		},
		{
			label: "flushes a tool-only session even without an assistant turn",
			activity: (lifecycle: MemoryLifecycle) => lifecycle.noteToolCall(),
			expectedFlush: true,
		},
		{
			label: "skips the flush when there is no pending durable activity",
			activity: () => {},
			expectedFlush: false,
		},
	])("$label", async ({ activity, expectedFlush }) => {
		const lifecycle = createLifecycle({
			minTurnsBetweenUpdate: 99,
			minToolCallsBetweenUpdate: 99,
			forceRefreshBeforeCompact: false,
			forceRefreshBeforeNewSession: false,
		});

		activity(lifecycle);

		await lifecycle.flushForShutdown();

		if (expectedFlush) {
			expect(runInlineConsolidation).toHaveBeenCalledTimes(1);
		} else {
			expect(runInlineConsolidation).not.toHaveBeenCalled();
		}
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
