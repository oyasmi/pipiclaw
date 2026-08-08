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
	it("releases the caller when an enqueued job stalls past the deadline", async () => {
		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);
		const { queue, drain } = createRunQueue();
		const stalled = createDeferred();
		queue.enqueue(() => stalled.promise, "stalled delivery");

		await drain(20);

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("drain deadline exceeded"),
			expect.stringContaining("timed out"),
		);
		stalled.resolve();
		warnSpy.mockRestore();
	});

	it("still waits for work that finishes inside the deadline", async () => {
		const { queue, drain } = createRunQueue();
		let done = false;
		queue.enqueue(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			done = true;
		}, "quick delivery");

		await drain(5_000);
		expect(done).toBe(true);
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
	it("force-releases a turn that never ends, and notifies the channel", async () => {
		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);
		const turn = createFakeTurnState();
		turn.beginTurn("stuck work");
		const notify = vi.fn(async () => {});

		const forced = await forceEndStuckTurnAfterStop({
			channelId: "dm_tester",
			runner: turn as never,
			graceMs: 30,
			pollMs: 5,
			notify,
		});

		expect(forced).toBe(true);
		expect(turn.isBusy()).toBe(false);
		expect(notify).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});

	it("does nothing when the turn ends within the grace window", async () => {
		const turn = createFakeTurnState();
		turn.beginTurn("normal work");
		setTimeout(() => turn.endTurn(), 10);
		const notify = vi.fn(async () => {});

		const forced = await forceEndStuckTurnAfterStop({
			channelId: "dm_tester",
			runner: turn as never,
			graceMs: 500,
			pollMs: 5,
			notify,
		});

		expect(forced).toBe(false);
		expect(notify).not.toHaveBeenCalled();
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
