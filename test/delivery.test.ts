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
	it("builds a full DingTalkContext surface", () => {
		const ctx = createDingTalkContext(
			createFakeEvent(),
			new FakeDingTalkBot() as never,
			new FakeChannelStore() as never,
		);

		expect(ctx.message.channel).toBe("dm_123");
		expect(typeof ctx.respond).toBe("function");
		expect(typeof ctx.respondPlain).toBe("function");
		expect(typeof ctx.replaceMessage).toBe("function");
		expect(typeof ctx.respondInThread).toBe("function");
		expect(typeof ctx.setTyping).toBe("function");
		expect(typeof ctx.setWorking).toBe("function");
		expect(typeof ctx.deleteMessage).toBe("function");
		expect(typeof ctx.primeCard).toBe("function");
		expect(typeof ctx.flush).toBe("function");
		expect(typeof ctx.close).toBe("function");
	});

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

	it("accumulates progress text and flushes one throttled card update", async () => {
		const bot = new FakeDingTalkBot();
		const store = new FakeChannelStore();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never);

		await ctx.respond("A");
		await ctx.respond("B");

		expect(bot.calls).toEqual([]);

		await vi.advanceTimersByTimeAsync(800);
		await ctx.flush();

		expect(bot.calls).toEqual([{ method: "appendToCard", args: ["dm_123", "A\n\nB"] }]);
		expect(store.logged).toHaveLength(2);
	});

	it("ignores blank progress updates", async () => {
		const bot = new FakeDingTalkBot();
		const store = new FakeChannelStore();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never);

		await ctx.respond("   ");
		await vi.runAllTimersAsync();
		await ctx.flush();

		expect(bot.calls).toEqual([]);
		expect(store.logged).toEqual([]);
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

	it("supports finalize-with-fallback and silent modes", async () => {
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
			{ method: "appendToCard", args: ["dm_123", "hello"] },
			{ method: "discardCard", args: ["dm_123"] },
			{ method: "replaceCard", args: ["dm_123", "hello\n\nworld", false] },
		]);
	});

	it("marks replay required when append throws and retries with a full snapshot", async () => {
		const throwingBot = new FakeDingTalkBot();
		throwingBot.appendToCard = vi.fn(async () => {
			throw new Error("boom");
		});
		const throwingCtx = createDingTalkContext(
			createFakeEvent(),
			throwingBot as never,
			new FakeChannelStore() as never,
		);

		await throwingCtx.respond("hello");
		await vi.advanceTimersByTimeAsync(800);
		await throwingCtx.flush();

		await throwingCtx.respond("world");
		await vi.advanceTimersByTimeAsync(800);
		await throwingCtx.flush();

		expect(throwingBot.discardCard).toBeDefined();
		expect(throwingBot.calls).toEqual([
			{ method: "discardCard", args: ["dm_123"] },
			{ method: "replaceCard", args: ["dm_123", "hello\n\nworld", false] },
		]);
	});

	it("continues delivering when bot response archiving fails", async () => {
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
			{ method: "appendToCard", args: ["dm_123", "progress"] },
			{ method: "sendPlain", args: ["dm_123", "final"] },
			{ method: "replaceCard", args: ["dm_123", "progress", true] },
		]);
	});
});
