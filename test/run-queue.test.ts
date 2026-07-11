import { describe, expect, it, vi } from "vitest";
import { createRunQueue } from "../src/agent/run-queue.js";
import * as log from "../src/log.js";

describe("createRunQueue", () => {
	it("runs enqueued work in submission order", async () => {
		const { queue, drain } = createRunQueue();
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
		const { queue, drain } = createRunQueue();
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

	it("drain resolves even when the queue is empty", async () => {
		const { drain } = createRunQueue();
		await expect(drain()).resolves.toBeUndefined();
	});
});
