import { describe, expect, it, vi } from "vitest";
import { handleSessionEvent, type SessionEventHandlerContext } from "../src/agent/session-events.js";
import { createEmptyRunState, type RunQueue, type RunState } from "../src/agent/types.js";
import type { ChannelContext } from "../src/runtime/channel-context.js";
import type { UsageLedger, UsageLedgerEntry } from "../src/usage/ledger.js";

function createQueue(): RunQueue {
	return {
		enqueue: async (fn) => {
			await fn();
		},
	};
}

function createLedger(records: Array<Omit<UsageLedgerEntry, "ts">> = []): UsageLedger {
	return {
		record: (entry) => {
			records.push(entry);
		},
		summarize: () => ({ totalCost: 0, entryCount: 0, byKind: {}, byModel: {}, byChannel: {} }),
	};
}

function createContext(respond = vi.fn(async () => {})): ChannelContext {
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
		progressStyle: "full",
		finalDelivery: "plain",
	};
}

function handlerContext(
	ctx: ChannelContext,
	runState: RunState,
	overrides: Partial<SessionEventHandlerContext> = {},
): SessionEventHandlerContext {
	return {
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
		ledger: createLedger(),
		...overrides,
	};
}

describe("session compaction events", () => {
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
			handlerContext(ctx, runState),
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
			handlerContext(ctx, runState),
		);

		expect(runState.lastCompactionError).toBeUndefined();
	});

	it("uses the same compaction progress label for threshold starts", async () => {
		const respond = vi.fn(async () => {});
		const ctx = createContext(respond);
		const runState = createEmptyRunState();

		await handleSessionEvent({ type: "compaction_start", reason: "threshold" }, handlerContext(ctx, runState));

		expect(respond).toHaveBeenCalledWith("Compacting context...", false);
	});

	it("hides compaction progress in final_card_only mode", async () => {
		const respond = vi.fn(async () => {});
		const ctx = createContext(respond);
		ctx.progressStyle = "none";
		ctx.finalDelivery = "card";
		const runState = createEmptyRunState();

		await handleSessionEvent({ type: "compaction_start", reason: "threshold" }, handlerContext(ctx, runState));

		expect(respond).not.toHaveBeenCalled();
	});

	it("does not push intermediate assistant text as progress in final_card_only mode", async () => {
		const respond = vi.fn(async () => {});
		const ctx = createContext(respond);
		ctx.progressStyle = "none";
		ctx.finalDelivery = "card";
		const runState = createEmptyRunState();

		await handleSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					stopReason: "toolUse",
					content: [
						{ type: "text", text: "Let me check that for you." },
						{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
					],
				},
			},
			handlerContext(ctx, runState),
		);

		expect(respond).not.toHaveBeenCalled();
	});
});

describe("usage accounting", () => {
	const assistantUsage = {
		input: 100,
		output: 40,
		cacheRead: 10,
		cacheWrite: 5,
		total: 155,
		cost: { input: 0.1, output: 0.04, cacheRead: 0.01, cacheWrite: 0.005, total: 0.155 },
	};

	it("adds assistant usage to both totalUsage (console) and assistantUsage (ledger)", async () => {
		const ctx = createContext();
		const runState = createEmptyRunState();

		await handleSessionEvent(
			{
				type: "message_end",
				message: { role: "assistant", stopReason: "endTurn", content: [], usage: assistantUsage },
			},
			handlerContext(ctx, runState),
		);

		expect(runState.totalUsage.cost.total).toBeCloseTo(0.155);
		expect(runState.assistantUsage.cost.total).toBeCloseTo(0.155);
		expect(runState.assistantUsage.input).toBe(100);
	});

	it("records sub-agent usage separately and excludes it from assistantUsage (no double counting)", async () => {
		const ctx = createContext();
		const runState = createEmptyRunState();
		const records: Array<Omit<UsageLedgerEntry, "ts">> = [];
		const context = handlerContext(ctx, runState, { ledger: createLedger(records) });

		// One assistant message (main loop) …
		await handleSessionEvent(
			{
				type: "message_end",
				message: { role: "assistant", stopReason: "endTurn", content: [], usage: assistantUsage },
			},
			context,
		);

		// … and one sub-agent tool completion.
		const subUsage = {
			input: 200,
			output: 80,
			cacheRead: 0,
			cacheWrite: 0,
			total: 280,
			cost: { input: 0.2, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.28 },
		};
		context.pendingTools.set("call-1", {
			toolName: "subagent",
			args: { label: "researcher" },
			startTime: Date.now(),
		});
		await handleSessionEvent(
			{
				type: "tool_execution_end",
				toolCallId: "call-1",
				toolName: "subagent",
				isError: false,
				result: {
					details: {
						kind: "subagent",
						agent: "researcher",
						source: "inline",
						model: "anthropic/claude-x",
						tools: [],
						turns: 1,
						toolCalls: 0,
						durationMs: 10,
						failed: false,
						usage: subUsage,
					},
				},
			},
			context,
		);

		// Ledger sees the sub-agent entry; assistantUsage stays assistant-only.
		const subEntry = records.find((r) => r.kind === "subagent");
		expect(subEntry?.cost.total).toBeCloseTo(0.28);
		expect(subEntry?.label).toBe("researcher");
		expect(runState.assistantUsage.cost.total).toBeCloseTo(0.155);
		// totalUsage (console) is assistant + sub-agent.
		expect(runState.totalUsage.cost.total).toBeCloseTo(0.435);
	});
});
