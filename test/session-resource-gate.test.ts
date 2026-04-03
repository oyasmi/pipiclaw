import { describe, expect, it, vi } from "vitest";
import { SessionResourceGate } from "../src/agent/session-resource-gate.js";

function createDeferred(): {
	promise: Promise<void>;
	resolve: () => void;
} {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("SessionResourceGate", () => {
	it("defers refresh requests until the active prompt completes", async () => {
		const reloadSessionResources = vi.fn(async () => {});
		const gate = new SessionResourceGate(reloadSessionResources);
		const promptDone = createDeferred();

		const promptPromise = gate.runPrompt(async () => {
			await gate.requestRefresh();
			expect(reloadSessionResources).not.toHaveBeenCalled();
			await promptDone.promise;
		});

		await Promise.resolve();
		expect(reloadSessionResources).not.toHaveBeenCalled();

		promptDone.resolve();
		await promptPromise;

		expect(reloadSessionResources).toHaveBeenCalledTimes(1);
	});

	it("coalesces multiple refresh requests into one reload after the turn", async () => {
		const reloadSessionResources = vi.fn(async () => {});
		const gate = new SessionResourceGate(reloadSessionResources);
		const promptDone = createDeferred();

		const promptPromise = gate.runPrompt(async () => {
			await Promise.all([gate.requestRefresh(), gate.requestRefresh(), gate.requestRefresh()]);
			await promptDone.promise;
		});

		promptDone.resolve();
		await promptPromise;

		expect(reloadSessionResources).toHaveBeenCalledTimes(1);
	});

	it("runs refresh immediately when no prompt is active", async () => {
		const reloadSessionResources = vi.fn(async () => {});
		const gate = new SessionResourceGate(reloadSessionResources);

		await gate.requestRefresh();

		expect(reloadSessionResources).toHaveBeenCalledTimes(1);
	});
});
