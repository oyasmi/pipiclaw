import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../src/shared/serial-queue.js";

// This tiny primitive underlies two mechanisms CLAUDE.md calls out as
// important and easy to get wrong: the per-channel run queue and the shared
// channel-maintenance queue that keeps lifecycle/maintenance-jobs from racing
// on the same channel's files. It had no dedicated test at all.
describe("createSerialQueue", () => {
	it("runs jobs for the same key one after another, in order", async () => {
		const queue = createSerialQueue<string>();
		const order: number[] = [];
		const job = (n: number, delayMs: number) =>
			queue.run("a", async () => {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				order.push(n);
			});

		await Promise.all([job(1, 20), job(2, 5), job(3, 0)]);
		expect(order).toEqual([1, 2, 3]);
	});

	it("runs jobs for different keys concurrently, not serialized", async () => {
		const queue = createSerialQueue<string>();
		let concurrent = 0;
		let maxConcurrent = 0;
		const job = (key: string) =>
			queue.run(key, async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((resolve) => setTimeout(resolve, 10));
				concurrent--;
			});

		await Promise.all([job("a"), job("b"), job("c")]);
		expect(maxConcurrent).toBeGreaterThan(1);
	});

	it("propagates each job's own result and rejection independently", async () => {
		const queue = createSerialQueue<string>();
		const first = queue.run("k", async () => "first");
		const second = queue.run("k", async () => {
			throw new Error("second failed");
		});
		const third = queue.run("k", async () => "third");

		await expect(first).resolves.toBe("first");
		await expect(second).rejects.toThrow("second failed");
		await expect(third).resolves.toBe("third");
	});
});
