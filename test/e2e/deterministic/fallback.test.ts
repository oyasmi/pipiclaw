import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: model fallback", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A22: a 429 on the primary model falls back to the backup and the turn still completes", async () => {
		// 017 fallback logic. Mutation check: make shouldFallback() return false for a 429
		// message and the turn ends with an error delivery instead of the backup's answer.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "answer",
			when: (r) => r.isMainTurn && r.lastUserText.includes("FALLBACK_TEST"),
			respond: [reply.text("备用模型答复。")],
			repeat: true,
		});
		harness.model.script.failNext({ status: 429 });

		await harness.sendUserMessage("FALLBACK_TEST 请回复");

		// The primary failed, the backup answered, the user got a reply.
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("备用模型答复"))).toBe(true);
		const mains = harness.mainTurnRequests();
		expect(mains.some((r) => r.matchedRoute === "__fail_429" && r.model === "mock-main")).toBe(true);
		expect(mains.some((r) => r.model === "mock-fallback")).toBe(true);
	});
});
