import { describe, expect, it, vi } from "vitest";
import { createRunQueue } from "../src/agent/run-queue.js";
import * as log from "../src/log.js";
import type { ChannelContext } from "../src/runtime/channel-context.js";

function fakeCtx(): {
	ctx: ChannelContext;
	respond: ReturnType<typeof vi.fn>;
	respondInThread: ReturnType<typeof vi.fn>;
} {
	const respond = vi.fn().mockResolvedValue(undefined);
	const respondInThread = vi.fn().mockResolvedValue(undefined);
	return {
		ctx: { respond, respondInThread } as unknown as ChannelContext,
		respond,
		respondInThread,
	};
}

describe("createRunQueue", () => {
	it("runs enqueued work in submission order", async () => {
		const { ctx } = fakeCtx();
		const { queue, drain } = createRunQueue(ctx);
		const order: number[] = [];
		queue.enqueue(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			order.push(1);
		}, "first");
		queue.enqueue(async () => {
			order.push(2);
		}, "second");

		await drain();
		expect(order).toEqual([1, 2]);
	});

	it("logs a warning and keeps draining when an enqueued job throws", async () => {
		const { ctx } = fakeCtx();
		const { queue, drain } = createRunQueue(ctx);
		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);
		let ranAfterFailure = false;

		queue.enqueue(async () => {
			throw new Error("boom");
		}, "failing step");
		queue.enqueue(async () => {
			ranAfterFailure = true;
		}, "next step");

		await drain();
		expect(ranAfterFailure).toBe(true);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failing step"), "boom");
		warnSpy.mockRestore();
	});

	it("enqueueMessage routes to respond for the main target and respondInThread for thread", async () => {
		const { ctx, respond, respondInThread } = fakeCtx();
		const { queue, drain } = createRunQueue(ctx);

		queue.enqueueMessage("hello main", "main", "main-send");
		queue.enqueueMessage("hello thread", "thread", "thread-send");
		await drain();

		expect(respond).toHaveBeenCalledWith("hello main", true);
		expect(respondInThread).toHaveBeenCalledWith("hello thread");
	});

	it("enqueueMessage forwards doLog=false through to respond", async () => {
		const { ctx, respond } = fakeCtx();
		const { queue, drain } = createRunQueue(ctx);

		queue.enqueueMessage("quiet", "main", "quiet-send", false);
		await drain();

		expect(respond).toHaveBeenCalledWith("quiet", false);
	});

	it("drain resolves even when the queue is empty", async () => {
		const { ctx } = fakeCtx();
		const { drain } = createRunQueue(ctx);
		await expect(drain()).resolves.toBeUndefined();
	});
});
