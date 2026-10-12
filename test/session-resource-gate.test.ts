import { describe, expect, it, vi } from "vitest";
import { SessionResourceGate } from "../src/agent/session/session-resource-gate.js";

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
	it("defers refresh requests until the active prompt completes, coalescing them into one reload", async () => {
		const reloadSessionResources = vi.fn(async () => {});
		const gate = new SessionResourceGate(reloadSessionResources);
		const promptDone = createDeferred();

		const promptPromise = gate.runPrompt(async () => {
			await Promise.all([gate.requestRefresh(), gate.requestRefresh(), gate.requestRefresh()]);
			expect(reloadSessionResources).not.toHaveBeenCalled();
			await promptDone.promise;
		});

		await Promise.resolve();
		expect(reloadSessionResources).not.toHaveBeenCalled();

		promptDone.resolve();
		await promptPromise;

		expect(reloadSessionResources).toHaveBeenCalledTimes(1);
		await gate.whenSettled();
		await gate.requestRefresh();
		expect(reloadSessionResources).toHaveBeenCalledTimes(2);
	});
});
