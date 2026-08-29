import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

describe("E2E deterministic: /stop", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
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
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn });

		await harness.sendUserMessageNoWait("开始一个长任务");
		await waitFor("turn running", () => harness.mainTurnRequests().length >= 1, { intervalMs: 20 });

		const before = harness.deliveries.length;
		await harness.sendUserMessageNoWait("/stop");
		gate.release();
		await harness.waitForIdle();

		const stopReplies = harness.deliveries.slice(before);
		expect(stopReplies.some((d) => (d.text ?? "").includes("已停止"))).toBe(true);
		// Channel is idle again and can take a fresh turn.
		harness.model.script.route({
			name: "next",
			when: (r) => r.isMainTurn && r.lastUserText.includes("STILL_ALIVE"),
			respond: [reply.text("yes, still here")],
		});
		await harness.sendUserMessage("STILL_ALIVE?");
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("still here"))).toBe(true);
	});
});
