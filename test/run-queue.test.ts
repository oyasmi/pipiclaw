import { describe, expect, it, vi } from "vitest";
import { createRunQueue } from "../src/agent/run-queue.js";
import * as log from "../src/log.js";

describe("createRunQueue", () => {
	it("logs a warning and keeps draining when an enqueued job throws", async () => {
		const { queue, drain } = createRunQueue();
		const warnSpy = vi.spyOn(log, "logWarn").mockImplementation(() => undefined);
		let ranAfterFailure = false;
		const order: number[] = [];
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		queue.enqueue(async () => {
			await held;
			order.push(1);
		}, "first");

		queue.enqueue(async () => {
			order.push(2);
			throw new Error("boom");
		}, "failing step");
		queue.enqueue(async () => {
			ranAfterFailure = true;
			order.push(3);
		}, "next step");

		await Promise.resolve();
		expect(order).toEqual([]);
		release();
		await drain();
		expect(order).toEqual([1, 2, 3]);
		expect(ranAfterFailure).toBe(true);
		expect(warnSpy).toHaveBeenCalledWith(
			"delivery.api.failed",
			expect.any(String),
			expect.objectContaining({ reason: "boom", fields: { context: expect.stringContaining("failing step") } }),
		);
		warnSpy.mockRestore();
	});
});
