import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

describe("E2E deterministic: concurrency & boundaries", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A4: messages that arrive mid-turn are serialized, not interleaved, and all answered", async () => {
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: [reply.text("ans-1"), reply.text("ans-2"), reply.text("ans-3")],
		});
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("MSG_ONE") });

		await harness.sendUserMessageNoWait("MSG_ONE");
		await waitFor("turn 1 held at provider", () => harness.mainTurnRequests().length >= 1, { intervalMs: 20 });
		await harness.sendUserMessageNoWait("MSG_TWO");
		await harness.sendUserMessageNoWait("MSG_THREE");

		// While turn 1 is held at the provider, no later turn may have started.
		expect(harness.mainTurnRequests()).toHaveLength(1);
		expect(harness.model.unmatched()).toHaveLength(0);

		gate.release();
		await harness.waitForIdle();

		// All three turns ran, in arrival order, one at a time.
		const order = harness.mainTurnRequests().map((r) => r.lastUserText.match(/MSG_\w+/)?.[0]);
		expect(order).toEqual(["MSG_ONE", "MSG_TWO", "MSG_THREE"]);
		for (const marker of ["ans-1", "ans-2", "ans-3"]) {
			expect(harness.deliveries.some((d) => (d.text ?? "").includes(marker))).toBe(true);
		}
	});

	it("A7: /new is an atomic boundary — the next turn's request carries no prior history", async () => {
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn,
			respond: Array.from({ length: 4 }, (_, i) => reply.text(`r${i}`)),
		});

		await harness.sendUserMessage("请记住暗号 MARKER_ALPHA_7788");
		expect(JSON.stringify(harness.lastMainTurnRequest()?.messages)).toContain("MARKER_ALPHA_7788");

		await harness.sendUserMessage("/new");
		await harness.sendUserMessage("/new"); // consecutive /new must not wedge

		await harness.sendUserMessage("现在说点别的");
		const afterNew = JSON.stringify(harness.lastMainTurnRequest()?.messages);
		expect(afterNew).not.toContain("MARKER_ALPHA_7788");
	});
});
