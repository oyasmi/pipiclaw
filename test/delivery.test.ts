import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { muteChannelContext } from "../src/channel/channel-context.js";
import { createDingTalkContext } from "../src/runtime/delivery.js";
import { FakeDingTalkBot } from "./helpers/fake-bot.js";
import { FakeChannelStore } from "./helpers/fake-store.js";
import { createFakeEvent } from "./helpers/fixtures.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(mode: FakeDingTalkBot["responseMode"] = "full_progress_then_plain_final") {
	const bot = new FakeDingTalkBot();
	bot.responseMode = mode;
	const store = new FakeChannelStore();
	const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never);
	return { bot, store, ctx };
}

describe("delivery", () => {
	it("delays the nonempty waiting notice and cancels it when the answer arrives first", async () => {
		const { bot, ctx } = setup();
		ctx.primeCard(1500);
		await vi.advanceTimersByTimeAsync(1499);
		expect(bot.calls).toEqual([]);
		await ctx.respondPlain("answer");
		await ctx.close();
		await vi.runAllTimersAsync();
		expect(bot.calls.map((c) => c.method)).toEqual(["sendPlain", "discardCard"]);
	});

	it.each(["full_progress_then_plain_final", "rolling_progress_then_plain_final"] as const)(
		"never clears a waiting or populated card on silent completion in %s",
		async (mode) => {
			const { bot, ctx } = setup(mode);
			ctx.primeCard(1500);
			await vi.advanceTimersByTimeAsync(1500);
			expect(bot.calls[0].method).toBe("replaceCard");
			expect(String(bot.calls[0].args[1]).trim()).not.toBe("");
			await ctx.respond("visible progress");
			await vi.advanceTimersByTimeAsync(800);
			await ctx.deleteMessage();
			await ctx.flush();
			expect(bot.calls.at(-1)?.method).toBe("finalizeExistingCard");
			expect(bot.calls.at(-1)?.args[1]).toContain("visible progress");
			expect(bot.calls.some((c) => c.method === "sendPlain")).toBe(false);
		},
	);

	it("finishes a waiting-only card with nonempty content after delivering the answer", async () => {
		const { bot, ctx } = setup();
		ctx.primeCard(1500);
		await vi.advanceTimersByTimeAsync(1500);
		await ctx.respondPlain("answer");
		await ctx.flush();
		expect(bot.calls.map((c) => c.method)).toEqual(["replaceCard", "sendPlain", "finalizeExistingCard"]);
		expect(String(bot.calls.at(-1)?.args[1]).trim()).not.toBe("");
	});

	it("coalesces progress, ignores blanks, and sends a snapshot before later deltas", async () => {
		const { bot, store, ctx } = setup();
		ctx.primeCard(1500);
		await ctx.respond(" ");
		await ctx.respond("A");
		await ctx.respond("B");
		await vi.advanceTimersByTimeAsync(799);
		expect(bot.calls).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(bot.calls).toEqual([{ method: "replaceCard", args: ["dm_123", "- A\n- B", false] }]);
		await ctx.respond("C");
		await vi.advanceTimersByTimeAsync(800);
		expect(bot.calls.at(-1)).toEqual({ method: "appendToCard", args: ["dm_123", "\n- C"] });
		expect(store.logged).toHaveLength(3);
	});

	it("keeps a rolling window and finishes it without sending the transcript as a second answer", async () => {
		const { bot, ctx } = setup("rolling_progress_then_plain_final");
		for (const text of ["A", "B", "C", "D", "E"]) {
			await ctx.respond(text);
			await vi.advanceTimersByTimeAsync(800);
		}
		expect(bot.calls.map((c) => c.method)).toEqual(Array(5).fill("replaceCard"));
		const last = String(bot.calls.at(-1)?.args[1]);
		expect(last).not.toContain("- A");
		expect(last).not.toContain("- B");
		for (const text of ["C", "D", "E"]) expect(last).toContain(`- ${text}`);
		await ctx.respondPlain("answer");
		await ctx.flush();
		expect(bot.calls.filter((c) => c.method === "sendPlain")).toHaveLength(1);
		expect(bot.calls.at(-1)?.method).toBe("finalizeExistingCard");
		expect(String(bot.calls.at(-1)?.args[1])).not.toContain("- E");
	});

	it("never primes a final-only or muted task context", async () => {
		for (const ctx of [setup("final_card_only"), setup()]) {
			const target = ctx.ctx.progressStyle === "none" ? ctx.ctx : muteChannelContext(ctx.ctx);
			target.primeCard(1);
			await target.respond("progress");
			await vi.runAllTimersAsync();
			expect(ctx.bot.calls).toEqual([]);
		}
	});

	it("background contexts deliver results but never prime or stream progress", async () => {
		const { bot, store } = setup();
		const ctx = createDingTalkContext(createFakeEvent(), bot as never, store as never, "none");
		ctx.primeCard(1);
		await ctx.respond("progress");
		await vi.runAllTimersAsync();
		await ctx.respondPlain("answer");
		await ctx.flush();
		expect(bot.calls).toEqual([{ method: "sendPlain", args: ["dm_123", "answer"] }]);
	});

	it("successful final replacement blocks progress, silence, and duplicate final delivery", async () => {
		const { bot, ctx } = setup();
		await ctx.replaceMessage("answer");
		await ctx.respond("late progress");
		await ctx.replaceMessage("duplicate");
		await ctx.deleteMessage();
		await vi.runAllTimersAsync();
		expect(bot.calls).toEqual([{ method: "finalizeCard", args: ["dm_123", "answer"] }]);
	});

	it("awaits actual final delivery and reports failure instead of marking an enqueue as success", async () => {
		const { bot, ctx } = setup();
		let release!: (ok: boolean) => void;
		bot.configure(
			"finalizeCard",
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		let settled = false;
		const final = ctx.replaceMessage("answer").finally(() => {
			settled = true;
		});
		const failure = expect(final).rejects.toThrow("发送失败");
		await Promise.resolve();
		expect(settled).toBe(false);
		await ctx.respond("late progress");
		release(false);
		await failure;
		expect(bot.calls.map((c) => c.method)).toEqual(["finalizeCard"]);
	});

	it("waits for in-flight progress before closing it and becomes inert after close", async () => {
		const { bot, ctx } = setup();
		let release!: (ok: boolean) => void;
		bot.configure(
			"replaceCard",
			new Promise<boolean>((resolve) => {
				release = resolve;
			}),
		);
		ctx.primeCard(1);
		await vi.advanceTimersByTimeAsync(1);
		let closed = false;
		const closing = ctx.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release(true);
		await closing;
		expect(bot.calls.map((c) => c.method)).toEqual(["replaceCard", "finalizeExistingCard", "discardCard"]);
		await ctx.respond("ignored");
		expect(await ctx.respondPlain("ignored")).toBe(false);
		await vi.runAllTimersAsync();
		expect(bot.calls).toHaveLength(3);
	});

	it("replays after an uncertain append and caps failed progress without discarding the card", async () => {
		const { bot, ctx } = setup();
		await ctx.respond("A");
		await vi.advanceTimersByTimeAsync(800);
		bot.configure("appendToCard", false);
		await ctx.respond("B");
		await vi.advanceTimersByTimeAsync(800);
		bot.configure("replaceCard", false);
		await ctx.respond("C");
		await vi.advanceTimersByTimeAsync(800);
		await ctx.respond("D");
		await vi.advanceTimersByTimeAsync(800);
		expect(bot.calls.map((c) => c.method)).toEqual(["replaceCard", "appendToCard", "replaceCard"]);
		expect(bot.calls.at(-1)?.args[1]).toBe("- A\n- B\n- C");
		await ctx.respondPlain("answer");
		await ctx.flush();
		expect(bot.calls.at(-1)?.method).toBe("finalizeExistingCard");
	});

	it("does not archive failed answers and tolerates archive failures", async () => {
		const { bot, store, ctx } = setup();
		bot.configure("sendPlain", false);
		expect(await ctx.respondPlain("undelivered")).toBe(false);
		expect(store.logged).toHaveLength(0);
		await ctx.replaceMessage("fallback");
		expect(bot.calls.at(-1)?.method).toBe("finalizeCard");
		const next = setup();
		next.store.logBotResponse = vi.fn(async () => {
			throw new Error("disk full");
		});
		expect(await next.ctx.respondPlain("answer")).toBe(true);
	});
});
