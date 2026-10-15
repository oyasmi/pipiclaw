import { afterEach, describe, expect, it, vi } from "vitest";
import * as apiKeys from "../../../src/models/api-keys.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: /stop", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it("A5: /stop aborts the running turn and returns the channel to idle", async () => {
		// Mutation check: make handleStop a no-op and the channel stays busy — waitForIdle
		// after /stop times out.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn && !r.lastUserText.includes("STILL_ALIVE"),
			respond: [reply.text("held then stopped")],
			repeat: true, // an aborted request may be retried by the client
		});
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && !r.lastUserText.includes("STILL_ALIVE") });

		await harness.sendUserMessageNoWait("开始一个长任务");
		await gate.arrived;

		const before = harness.deliveries.length;
		await harness.sendUserMessageNoWait("/stop");
		try {
			// The provider is still held: finishing normally cannot masquerade as cancellation.
			await harness.waitForIdle();
			expect(harness.deliveries.slice(before).filter((d) => d.method === "sendPlain")).toHaveLength(1);
			expect(harness.deliveries.some((d) => (d.text ?? "").includes("held then stopped"))).toBe(false);
		} finally {
			gate.release();
		}
		// Also stop during backup credential resolution; an abort between requests must not revive the turn.
		// Spec 055 mutation (executed 2026-10-13; restored green): remove canRetry stop checks; backup provider count becomes 1.
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const keyGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const getKey = apiKeys.getApiKeyForModel;
		vi.spyOn(apiKeys, "getApiKeyForModel").mockImplementation(async (registry, model) => {
			if (model.id === "mock-fallback") {
				entered();
				await keyGate;
			}
			return getKey(registry, model);
		});
		harness.model.script.failNext({ status: 429 });
		await harness.sendUserMessageNoWait("FAIL_THEN_STOP");
		await waiting;
		try {
			await harness.sendUserMessageNoWait("/stop");
		} finally {
			release();
		}
		await harness.waitForIdle();
		expect(harness.model.requests.filter((request) => request.model === "mock-fallback")).toHaveLength(0);
		vi.restoreAllMocks();

		// Channel is idle again and can take a fresh turn.
		harness.model.script.route({
			name: "next",
			when: (r) => r.isMainTurn && r.lastUserText.includes("STILL_ALIVE"),
			respond: [reply.text("yes, still here")],
		});
		await harness.sendUserMessage("STILL_ALIVE?");
		expect(harness.lastMainTurnRequest()?.matchedRoute).toBe("next");
	});
});
