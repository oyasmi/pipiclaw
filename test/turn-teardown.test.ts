import { describe, expect, it, vi } from "vitest";
import { createRunQueue } from "../src/agent/run-queue.js";
import { SessionResourceGate } from "../src/agent/session-resource-gate.js";
import * as log from "../src/log.js";
import { forceEndStuckTurnAfterStop } from "../src/runtime/bootstrap.js";
import { createFakeTurnState } from "./helpers/fake-turn-state.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("run queue drain deadline", () => {
	it("waits for work that finishes in time and releases the caller when a job stalls past the deadline", async () => {
		const { queue, drain } = createRunQueue();
		let done = false;
		queue.enqueue(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			done = true;
		}, "quick delivery");

		await drain(5_000);
		expect(done).toBe(true);

		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);
		const stalledQueue = createRunQueue();
		const stalled = createDeferred();
		stalledQueue.queue.enqueue(() => stalled.promise, "stalled delivery");

		await stalledQueue.drain(20);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("drain deadline exceeded"),
			expect.stringContaining("timed out"),
		);
		stalled.resolve();
		warnSpy.mockRestore();
	});
});

describe("SessionResourceGate refresh detachment", () => {
	it("does not hold the prompt open while the deferred reload runs", async () => {
		const reloadStarted = createDeferred();
		const reloadDone = createDeferred();
		const gate = new SessionResourceGate(async () => {
			reloadStarted.resolve();
			await reloadDone.promise;
		});

		await gate.runPrompt(async () => {
			await gate.requestRefresh();
		});

		// The prompt has returned; the reload is still in flight.
		await reloadStarted.promise;
		let settled = false;
		void gate.whenSettled().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		reloadDone.resolve();
		await gate.whenSettled();
	});

	it("orders the next prompt behind the detached reload", async () => {
		const order: string[] = [];
		const reloadDone = createDeferred();
		const gate = new SessionResourceGate(async () => {
			order.push("reload:start");
			await reloadDone.promise;
			order.push("reload:end");
		});

		await gate.runPrompt(async () => {
			await gate.requestRefresh();
			order.push("prompt-1");
		});

		const secondPrompt = gate.runPrompt(async () => {
			order.push("prompt-2");
		});
		await Promise.resolve();
		expect(order).not.toContain("prompt-2");

		reloadDone.resolve();
		await secondPrompt;
		expect(order).toEqual(["prompt-1", "reload:start", "reload:end", "prompt-2"]);
	});

	it("keeps serving prompts after a reload fails", async () => {
		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);
		const gate = new SessionResourceGate(async () => {
			throw new Error("provider unreachable");
		});

		await gate.runPrompt(async () => {
			await gate.requestRefresh();
		});
		await gate.whenSettled();
		await expect(gate.runPrompt(async () => "ok")).resolves.toBe("ok");

		expect(warnSpy).toHaveBeenCalledWith("Session resource reload failed", "provider unreachable");
		warnSpy.mockRestore();
	});
});

describe("forceEndStuckTurnAfterStop", () => {
	it("force-releases a turn that never ends, but does nothing when it ends within the grace window", async () => {
		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);

		// Ends in time: no force, no notification.
		const timely = createFakeTurnState();
		timely.beginTurn("normal work");
		setTimeout(() => timely.endTurn(), 10);
		const silentNotify = vi.fn(async () => {});

		expect(
			await forceEndStuckTurnAfterStop({
				channelId: "dm_tester",
				runner: timely as never,
				graceMs: 500,
				pollMs: 5,
				notify: silentNotify,
			}),
		).toBe(false);
		expect(silentNotify).not.toHaveBeenCalled();

		// Stuck past the grace window: force-released and the channel notified.
		const stuck = createFakeTurnState();
		stuck.beginTurn("stuck work");
		const notify = vi.fn(async () => {});

		expect(
			await forceEndStuckTurnAfterStop({
				channelId: "dm_tester",
				runner: stuck as never,
				graceMs: 30,
				pollMs: 5,
				notify,
			}),
		).toBe(true);
		expect(stuck.isBusy()).toBe(false);
		expect(notify).toHaveBeenCalledTimes(1);

		warnSpy.mockRestore();
	});

	it("ignores the stuck turn's own late release so the next turn keeps its busy state", async () => {
		const turn = createFakeTurnState();
		turn.beginTurn("stuck work");

		await forceEndStuckTurnAfterStop({
			channelId: "dm_tester",
			runner: turn as never,
			graceMs: 10,
			pollMs: 5,
		});

		turn.beginTurn("next message");
		// The wedged turn finally finishes its epilogue and releases.
		turn.endTurn();

		expect(turn.isBusy()).toBe(true);
	});
});
