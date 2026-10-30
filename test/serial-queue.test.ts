import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../src/shared/serial-queue.js";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// This tiny primitive underlies two mechanisms CLAUDE.md calls out as
// important and easy to get wrong: the per-channel run queue and the shared
// channel-maintenance queue that keeps lifecycle/maintenance-jobs from racing
// on the same channel's files. It had no dedicated test at all.
describe("createSerialQueue", () => {
	it("runs jobs for the same key one after another, in order", async () => {
		const queue = createSerialQueue<string>();
		const order: number[] = [];
		const entered = barrier();
		const release = barrier();
		const first = queue.run("a", async () => {
			order.push(1);
			entered.resolve();
			await release.promise;
		});
		const second = queue.run("a", async () => {
			order.push(2);
		});
		const third = queue.run("a", async () => {
			order.push(3);
		});
		try {
			await entered.promise;
			expect(order).toEqual([1]);
		} finally {
			release.resolve();
			await Promise.all([first, second, third]);
		}
		expect(order).toEqual([1, 2, 3]);
	});

	it("runs jobs for different keys concurrently, not serialized", async () => {
		const queue = createSerialQueue<string>();
		const order: string[] = [];
		const entered = barrier();
		const release = barrier();
		const first = queue.run("a", async () => {
			entered.resolve();
			await release.promise;
			order.push("a");
		});
		await entered.promise;
		// A different key must finish while the first is still held; a global queue deadlocks.
		const second = queue.run("b", async () => {
			order.push("b");
			release.resolve();
		});
		await Promise.all([first, second]);
		expect(order).toEqual(["b", "a"]);
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
