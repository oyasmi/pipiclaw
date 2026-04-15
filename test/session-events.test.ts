import { describe, expect, it, vi } from "vitest";
import { handleSessionEvent } from "../src/agent/session-events.js";
import { isAutoCompactionEndEvent, isAutoCompactionStartEvent } from "../src/agent/type-guards.js";
import { createEmptyRunState, type RunQueue } from "../src/agent/types.js";
import type { DingTalkContext } from "../src/runtime/dingtalk.js";

function createQueue(): RunQueue {
	return {
		enqueue: async (fn) => {
			await fn();
		},
		enqueueMessage: async () => {},
	};
}

function createContext(respond = vi.fn(async () => {})): DingTalkContext {
	return {
		message: {
			text: "",
			rawText: "",
			user: "tester",
			userName: "Tester",
			channel: "dm_tester",
			ts: "1000",
		},
		respond,
		respondPlain: vi.fn(async () => true),
		replaceMessage: vi.fn(async () => {}),
		respondInThread: vi.fn(async () => {}),
		setTyping: vi.fn(async () => {}),
		setWorking: vi.fn(async () => {}),
		deleteMessage: vi.fn(async () => {}),
		primeCard: vi.fn(),
		flush: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
}

describe("session compaction events", () => {
	it("accepts both legacy and current compaction start event names", () => {
		expect(isAutoCompactionStartEvent({ type: "auto_compaction_start", reason: "overflow" })).toBe(true);
		expect(isAutoCompactionStartEvent({ type: "compaction_start", reason: "threshold" })).toBe(true);
		expect(isAutoCompactionStartEvent({ type: "compaction_start", reason: "manual" })).toBe(true);
	});

	it("accepts both legacy and current compaction end event names", () => {
		expect(isAutoCompactionEndEvent({ type: "auto_compaction_end" })).toBe(true);
		expect(isAutoCompactionEndEvent({ type: "compaction_end", errorMessage: "failed" })).toBe(true);
	});

	it("surfaces compaction failure diagnostics to DingTalk and run state", async () => {
		const respond = vi.fn(async () => {});
		const ctx = createContext(respond);
		const runState = createEmptyRunState();

		await handleSessionEvent(
			{
				type: "compaction_end",
				reason: "overflow",
				errorMessage: "Context overflow recovery failed: summarization failed",
			},
			{
				ctx,
				logCtx: { channelId: "dm_tester", userName: "Tester" },
				queue: createQueue(),
				pendingTools: new Map(),
				store: null,
				runState,
				memoryLifecycle: {
					noteToolCall() {},
					noteCompletedAssistantTurn() {},
				} as never,
			},
		);

		expect(runState.lastCompactionError).toBe("Context overflow recovery failed: summarization failed");
		expect(respond).toHaveBeenCalledWith("Error: Context overflow recovery failed: summarization failed", false);
	});

	it("clears stale compaction diagnostics after a successful compaction", async () => {
		const ctx = createContext();
		const runState = createEmptyRunState();
		runState.lastCompactionError = "previous failure";

		await handleSessionEvent(
			{
				type: "compaction_end",
				reason: "threshold",
				result: { tokensBefore: 12345 },
			},
			{
				ctx,
				logCtx: { channelId: "dm_tester", userName: "Tester" },
				queue: createQueue(),
				pendingTools: new Map(),
				store: null,
				runState,
				memoryLifecycle: {
					noteToolCall() {},
					noteCompletedAssistantTurn() {},
				} as never,
			},
		);

		expect(runState.lastCompactionError).toBeUndefined();
	});

	it.each(["manual", "threshold", "overflow"] as const)(
		"uses the same compaction progress label for %s starts",
		async (reason) => {
			const respond = vi.fn(async () => {});
			const ctx = createContext(respond);
			const runState = createEmptyRunState();

			await handleSessionEvent(
				{
					type: "compaction_start",
					reason,
				},
				{
					ctx,
					logCtx: { channelId: "dm_tester", userName: "Tester" },
					queue: createQueue(),
					pendingTools: new Map(),
					store: null,
					runState,
					memoryLifecycle: {
						noteToolCall() {},
						noteCompletedAssistantTurn() {},
					} as never,
				},
			);

			expect(respond).toHaveBeenCalledWith("Compacting context...", false);
		},
	);
});
