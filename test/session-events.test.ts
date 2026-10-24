import { describe, expect, it } from "vitest";
import { handleSessionEvent, type SessionEventHandlerContext } from "../src/agent/session/session-events.js";
import { TurnOutput } from "../src/agent/turn/turn-output.js";
import { createEmptyRunState, type RunQueue, type RunState } from "../src/agent/types.js";
import type { TurnEvent } from "../src/channel/channel-context.js";
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
		summarize: async () => ({
			totalCost: 0,
			totalTokens: 0,
			entryCount: 0,
			byKind: {},
			byModel: {},
			byChannel: {},
			byTask: {},
			unknownUsageCount: 0,
			unknownCostCount: 0,
		}),
	};
}

/** A turn output that records what the handler emits. */
function createOutput(): { ctx: TurnOutput; events: TurnEvent[] } {
	const events: TurnEvent[] = [];
	const ctx = new TurnOutput({ emit: (event) => events.push(event), finish: async () => {} }, "dingtalk:dm:tester");
	return { ctx, events };
}

function handlerContext(
	ctx: TurnOutput,
	runState: RunState,
	overrides: Partial<SessionEventHandlerContext> = {},
): SessionEventHandlerContext {
	return {
		ctx,
		logCtx: { channelId: "dingtalk:dm:tester", userName: "Tester" },
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

const assistant = (content: unknown[], stopReason = "endTurn") => ({
	role: "assistant",
	stopReason,
	content,
});

describe("turn events from session events", () => {
	it("turns a tool round trip into start and end events and its narrative into reasoning and commentary", async () => {
		const { ctx, events } = createOutput();
		const context = handlerContext(ctx, createEmptyRunState());

		await handleSessionEvent(
			{
				type: "message_end",
				message: assistant(
					[
						{ type: "thinking", thinking: "plan it" },
						{ type: "text", text: "Let me check." },
						{ type: "toolCall", id: "t1", name: "bash", arguments: {} },
					],
					"toolUse",
				),
			},
			context,
		);
		await handleSessionEvent(
			{ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
			context,
		);
		await handleSessionEvent(
			{
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				isError: false,
				result: { content: [{ type: "text", text: "a.txt" }], details: { kind: "bash" } },
			},
			context,
		);

		expect(events).toEqual([
			{ type: "reasoning", text: "plan it" },
			{ type: "commentary", text: "Let me check." },
			{ type: "tool.start", callId: "t1", tool: "bash", args: { command: "ls" } },
			{ type: "tool.end", callId: "t1", ok: true, output: "a.txt" },
		]);
	});

	it("emits an answer only for a non-empty, non-[SILENT] reply, and records how the turn is ending", async () => {
		const turnEnd = (text: string) => ({
			type: "turn_end",
			message: assistant([{ type: "text", text }]),
			toolResults: [],
		});
		const cases: Array<{ text: string; answered: boolean; outcome: RunState["finalOutcome"]["kind"] }> = [
			{ text: "Done.", answered: true, outcome: "final" },
			{ text: "[SILENT]", answered: false, outcome: "silent" },
			// A reply with nothing in it ends the turn quietly instead of leaving a card waiting.
			{ text: "   ", answered: false, outcome: "silent" },
		];
		for (const { text, answered, outcome } of cases) {
			const { ctx, events } = createOutput();
			const runState = createEmptyRunState();
			await handleSessionEvent(turnEnd(text), handlerContext(ctx, runState));
			expect(
				events.filter((event) => event.type === "answer"),
				text,
			).toHaveLength(answered ? 1 : 0);
			expect(runState.answerEmitted).toBe(answered);
			expect(runState.finalOutcome.kind).toBe(outcome);
		}
	});

	it("marks a message injected after the turn's own prompt as applied steering, and lets the answer after it through", async () => {
		const { ctx, events } = createOutput();
		const context = handlerContext(ctx, createEmptyRunState());
		const user = (text: string) => ({ type: "message_start", message: { role: "user", content: text } });
		const final = (text: string) => ({
			type: "turn_end",
			message: assistant([{ type: "text", text }]),
			toolResults: [],
		});

		await handleSessionEvent(user("the prompt"), context);
		await handleSessionEvent(final("first answer"), context);
		await handleSessionEvent(user("a steering message"), context);
		await handleSessionEvent(final("answer after steering"), context);

		expect(events).toEqual([
			{ type: "answer", text: "first answer" },
			{ type: "steer.applied" },
			{ type: "answer", text: "answer after steering" },
		]);
	});

	it("does not emit a turn's own error as an answer", async () => {
		const { ctx, events } = createOutput();
		await handleSessionEvent(
			{
				type: "turn_end",
				message: assistant([{ type: "text", text: "partial" }], "error"),
				toolResults: [],
			},
			handlerContext(ctx, createEmptyRunState()),
		);
		expect(events).toEqual([]);
	});
});

describe("session compaction events", () => {
	it("surfaces compaction failure as an error line and in run state, without the raw provider text", async () => {
		const { ctx, events } = createOutput();
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
		const lines = events.filter((event) => event.type === "commentary");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: "error" });
		// The classified user line; the raw provider text stays in run state and the log.
		expect(JSON.stringify(lines[0])).not.toContain("summarization failed");
	});

	it("clears stale compaction diagnostics after a successful compaction", async () => {
		const { ctx } = createOutput();
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
		const { ctx } = createOutput();
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

	it("distinguishes known model pricing from an all-zero unknown cost", async () => {
		const unknownUsage = {
			...assistantUsage,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const unknownState = createEmptyRunState();
		await handleSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					provider: "custom",
					model: "unpriced",
					stopReason: "endTurn",
					content: [],
					usage: unknownUsage,
				},
			},
			handlerContext(createOutput().ctx, unknownState, { isModelCostKnown: () => false }),
		);
		expect(unknownState.usageSources).toBe(1);
		expect(unknownState.costKnown).toBe(false);

		const knownState = createEmptyRunState();
		await handleSessionEvent(
			{
				type: "message_end",
				message: {
					role: "assistant",
					provider: "priced",
					model: "model",
					stopReason: "endTurn",
					content: [],
					usage: unknownUsage,
				},
			},
			handlerContext(createOutput().ctx, knownState, { isModelCostKnown: () => true }),
		);
		expect(knownState.costKnown).toBe(true);
	});

	it("folds sub-agent usage into the turn tally without double counting, and no longer writes the ledger itself (spec 040 D7)", async () => {
		const { ctx } = createOutput();
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

		// Spec 040, D7: `runs.ts` is now the sole ledger/archive authority for delegation runs, so
		// this handler must not write a ledger entry itself — only fold usage into the turn tally.
		expect(records.find((r) => r.kind === "subagent")).toBeUndefined();
		expect(runState.assistantUsage.cost.total).toBeCloseTo(0.155);
		// totalUsage (console) is assistant + sub-agent.
		expect(runState.totalUsage.cost.total).toBeCloseTo(0.435);
	});
});
