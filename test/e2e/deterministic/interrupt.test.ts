import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

describe("E2E deterministic: /steer & /followup", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A6: /steer joins the running turn; /followup runs as the next turn", async () => {
		// Mutation check: route /steer through handleBusyMessage's followUp branch instead
		// of queueSteer and STEER_MARKER stops appearing inside the first turn.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn && !r.lastUserText.includes("FOLLOWUP_MARKER"),
			respond: [reply.text("turn1 continues")],
			repeat: true,
		});
		harness.model.script.route({
			name: "followup-turn",
			when: (r) => r.isMainTurn && r.lastUserText.includes("FOLLOWUP_MARKER"),
			respond: [reply.text("handled the follow-up")],
		});
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && r.lastUserText.includes("ORIGINAL_TASK") });

		await harness.sendUserMessageNoWait("开始 ORIGINAL_TASK");
		await waitFor("turn 1 running", () => harness.mainTurnRequests().length >= 1, { intervalMs: 20 });

		await harness.sendUserMessageNoWait("/steer 补充要求 STEER_MARKER");
		await harness.sendUserMessageNoWait("/followup 之后再看 FOLLOWUP_MARKER");

		gate.release();
		await harness.waitForIdle();

		// The steer text was fed into turn 1 (a later request in the same turn carries it).
		const steerLandedInTurn1 = harness.mainTurnRequests().some((r) => r.lastUserText.includes("STEER_MARKER"));
		expect(steerLandedInTurn1).toBe(true);

		// The follow-up ran as its own separate turn.
		expect(harness.model.requests.some((r) => r.matchedRoute === "followup-turn")).toBe(true);
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("handled the follow-up"))).toBe(true);
	});
});
