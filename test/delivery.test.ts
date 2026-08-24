import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDingTalkContext } from "../src/runtime/delivery.js";
import { FakeDingTalkBot } from "./helpers/fake-bot.js";
import { FakeChannelStore } from "./helpers/fake-store.js";
import { createFakeEvent } from "./helpers/fixtures.js";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("delivery", () => {
	it("warms an AI card after 350ms when no progress has been emitted yet", async () => {
		const bot = new FakeDingTalkBot();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, new FakeChannelStore() as never);

		ctx.primeCard(350);
		await vi.advanceTimersByTimeAsync(349);
		expect(bot.calls).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(bot.calls).toEqual([{ method: "ensureCard", args: ["dm_123"] }]);
	});

	it("cancels AI card warmup once visible progress starts", async () => {
		const bot = new FakeDingTalkBot();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, new FakeChannelStore() as never);

		ctx.primeCard(350);
		await ctx.respond("working");
		await vi.advanceTimersByTimeAsync(350);

		expect(bot.calls).toEqual([]);
	});

	it("accumulates progress text, ignores blanks, and flushes one throttled card update", async () => {
		const bot = new FakeDingTalkBot();
		const store = new FakeChannelStore();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never);

		await ctx.respond("   ");
		await vi.runAllTimersAsync();
		await ctx.flush();
		expect(bot.calls).toEqual([]);
		expect(store.logged).toEqual([]);

		await ctx.respond("A");
		await ctx.respond("B");

		expect(bot.calls).toEqual([]);

		await vi.advanceTimersByTimeAsync(800);
		await ctx.flush();

		expect(bot.calls).toEqual([{ method: "appendToCard", args: ["dm_123", "- A\n- B"] }]);
		expect(store.logged).toHaveLength(2);
	});

	it("keeps only the recent progress window in rolling mode", async () => {
		const bot = new FakeDingTalkBot();
		bot.responseMode = "rolling_progress_then_plain_final";
		const store = new FakeChannelStore();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never);

		for (const entry of ["A", "B", "C", "D", "E"]) {
			await ctx.respond(entry);
			await vi.advanceTimersByTimeAsync(800);
			await ctx.flush();
		}

		// Rolling mode always replaces: the standing header (elapsed · steps) changes every update,
		// so an append-only delta would leave a stale first line on the card.
		expect(bot.calls.map((call) => call.method)).toEqual(Array(5).fill("replaceCard"));
		expect(bot.calls.map((call) => String(call.args[1]).replace(/^⏱ \d+s · /, ""))).toEqual([
			"0 步\n\n- A",
			"0 步\n\n- A\n- B",
			"0 步\n\n- A\n- B\n- C",
			"0 步\n\n- B\n- C\n- D",
			"0 步\n\n- C\n- D\n- E",
		]);
		expect(store.logged.map((entry) => entry.args[1])).toEqual(["A", "B", "C", "D", "E"]);
	});

	it("replaces rolling progress with a compact summary after a final plain response", async () => {
		const bot = new FakeDingTalkBot();
		bot.responseMode = "rolling_progress_then_plain_final";
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, new FakeChannelStore() as never);

		await ctx.respond("➜ read docs");
		await vi.advanceTimersByTimeAsync(800);
		await ctx.flush();
		await vi.advanceTimersByTimeAsync(1200);
		await ctx.respond("✦ checking design");
		await vi.advanceTimersByTimeAsync(800);
		await ctx.flush();
		await vi.advanceTimersByTimeAsync(1200);
		await ctx.respond("➜ update files");
		await vi.advanceTimersByTimeAsync(800);
		await ctx.flush();

		// The standing header counts tool steps while the turn is still running.
		expect(String(bot.calls.at(-1)?.args[1])).toMatch(/^⏱ \d+s · 2 步\n\n/);

		await expect(ctx.respondPlain("final answer")).resolves.toBe(true);
		await ctx.flush();

		const finalCall = bot.calls.at(-1);
		expect(bot.calls.at(-2)).toEqual({ method: "sendPlain", args: ["dm_123", "final answer"] });
		expect(finalCall?.method).toBe("replaceCard");
		expect(finalCall?.args[0]).toBe("dm_123");
		expect(finalCall?.args[1]).toMatch(/^完成 · 2 步 · \d+s$/);
		expect(finalCall?.args[1]).not.toContain("➜");
		expect(finalCall?.args[2]).toBe(true);
	});

	it("sends final plain responses and blocks later progress", async () => {
		const bot = new FakeDingTalkBot();
		const store = new FakeChannelStore();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never);

		await expect(ctx.respondPlain("final")).resolves.toBe(true);
		await ctx.respond("after");
		await vi.runAllTimersAsync();
		await ctx.flush();

		expect(bot.calls).toEqual([
			{ method: "sendPlain", args: ["dm_123", "final"] },
			{ method: "discardCard", args: ["dm_123"] },
		]);
		expect(store.logged).toHaveLength(1);
	});

	it("keeps a background wake off the card but still delivers its answer, or leaves nothing to delete when it ends silently", async () => {
		const bot = new FakeDingTalkBot();
		const store = new FakeChannelStore();
		// What bootstrap passes for a synthetic event (task driver, job wake, scheduled event).
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never, "none");

		expect(ctx.progressStyle).toBe("none");
		await ctx.respond("➜ bash");
		await vi.runAllTimersAsync();
		await ctx.flush();
		expect(bot.calls).toEqual([]);
		expect(store.logged).toHaveLength(0);

		await expect(ctx.respondPlain("done")).resolves.toBe(true);
		await ctx.flush();
		expect(bot.calls).toEqual([
			{ method: "sendPlain", args: ["dm_123", "done"] },
			// No card was ever created, so finalizing is just the local cleanup.
			{ method: "discardCard", args: ["dm_123"] },
		]);

		// A separate wake that ends silently (no reply, just cleanup) leaves nothing to delete.
		const silentBot = new FakeDingTalkBot();
		const silentCtx = createDingTalkContext(
			createFakeEvent(),
			silentBot as never,
			new FakeChannelStore() as never,
			"none",
		);
		await silentCtx.respond("➜ bash");
		await silentCtx.deleteMessage();
		await vi.runAllTimersAsync();
		await silentCtx.flush();
		expect(silentBot.calls).toEqual([{ method: "discardCard", args: ["dm_123"] }]);
	});

	it("finalizes a warmed card cleanly when the task finishes before any progress text", async () => {
		const bot = new FakeDingTalkBot();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, new FakeChannelStore() as never);

		ctx.primeCard(350);
		await vi.advanceTimersByTimeAsync(350);

		await expect(ctx.respondPlain("final")).resolves.toBe(true);
		await ctx.flush();

		expect(bot.calls).toEqual([
			{ method: "ensureCard", args: ["dm_123"] },
			{ method: "sendPlain", args: ["dm_123", "final"] },
			{ method: "replaceCard", args: ["dm_123", "", true] },
		]);
	});

	it("supports finalize-with-fallback and silent modes in both response modes", async () => {
		const bot = new FakeDingTalkBot();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, new FakeChannelStore() as never);

		await ctx.replaceMessage("replacement");
		await ctx.flush();
		await ctx.deleteMessage();
		await ctx.flush();

		expect(bot.calls).toEqual([
			{ method: "finalizeCard", args: ["dm_123", "replacement"] },
			{ method: "discardCard", args: ["dm_123"] },
		]);

		// Rolling mode preserves the replacement text as the finalize fallback too.
		const rollingBot = new FakeDingTalkBot();
		rollingBot.responseMode = "rolling_progress_then_plain_final";
		const rollingCtx = createDingTalkContext(createFakeEvent(), rollingBot as never, new FakeChannelStore() as never);
		await rollingCtx.respond("➜ collect context");
		await vi.advanceTimersByTimeAsync(800);
		await rollingCtx.flush();
		await rollingCtx.replaceMessage("final fallback text");
		await rollingCtx.flush();

		expect(rollingBot.calls.at(-1)).toEqual({ method: "finalizeCard", args: ["dm_123", "final fallback text"] });
	});

	it("waits for in-flight delivery and becomes inert after close", async () => {
		const bot = new FakeDingTalkBot();
		bot.configure(
			"appendToCard",
			new Promise<boolean>((resolve) => {
				setTimeout(() => resolve(true), 50);
			}),
		);
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, new FakeChannelStore() as never);

		await ctx.respond("hello");
		await vi.advanceTimersByTimeAsync(800);

		const pendingFlush = ctx.flush();
		await vi.advanceTimersByTimeAsync(50);
		await pendingFlush;

		await ctx.close();
		await ctx.respond("ignored");
		await expect(ctx.respondPlain("also ignored")).resolves.toBe(false);
		await vi.runAllTimersAsync();

		expect(bot.calls.filter((call) => call.method === "appendToCard")).toHaveLength(1);
	});

	it("replays the full transcript after an append failure", async () => {
		const failedBot = new FakeDingTalkBot();
		failedBot.configure("appendToCard", false);
		const failedCtx = createDingTalkContext(createFakeEvent(), failedBot as never, new FakeChannelStore() as never);

		await failedCtx.respond("hello");
		await vi.advanceTimersByTimeAsync(800);
		await failedCtx.flush();

		await failedCtx.respond("world");
		await vi.advanceTimersByTimeAsync(800);
		await failedCtx.flush();

		expect(failedBot.calls).toEqual([
			{ method: "appendToCard", args: ["dm_123", "- hello"] },
			{ method: "discardCard", args: ["dm_123"] },
			{ method: "replaceCard", args: ["dm_123", "- hello\n- world", false] },
		]);
	});

	it("keeps archiving honest in both failure directions: undelivered finals and failing stores", async () => {
		// A final response that failed to deliver is never archived.
		const failedBot = new FakeDingTalkBot();
		failedBot.configure("sendPlain", false);
		const failedStore = new FakeChannelStore();
		const failedCtx = createDingTalkContext(createFakeEvent(), failedBot as never, failedStore as never);

		await expect(failedCtx.respondPlain("undelivered")).resolves.toBe(false);

		expect(failedBot.calls).toEqual([{ method: "sendPlain", args: ["dm_123", "undelivered"] }]);
		expect(failedStore.logged).toHaveLength(0);

		// Conversely, a failing archive must not break delivery itself.
		const bot = new FakeDingTalkBot();
		const store = new FakeChannelStore();
		store.logBotResponse = vi.fn(async () => {
			throw new Error("disk full");
		});
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never);

		await ctx.respond("progress");
		await vi.advanceTimersByTimeAsync(800);
		await ctx.flush();

		await expect(ctx.respondPlain("final")).resolves.toBe(true);

		expect(bot.calls).toEqual([
			{ method: "appendToCard", args: ["dm_123", "- progress"] },
			{ method: "sendPlain", args: ["dm_123", "final"] },
			{ method: "replaceCard", args: ["dm_123", "- progress", true] },
		]);
	});
});
