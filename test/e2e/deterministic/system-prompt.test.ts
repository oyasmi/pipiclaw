import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

/**
 * System-prompt ownership (spec 048 D5). Asserted directly on the body the
 * provider received — no `PIPICLAW_DEBUG`, no `last_prompt.json` intermediary.
 */
describe("E2E deterministic: system prompt", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("sends the Pipiclaw prompt with pi's default base prompt gone, boundary last", async () => {
		harness = await createDeterministicHarness();
		harness.model.script.route({ name: "t", when: (r) => r.isMainTurn, respond: [reply.text("ok")] });
		await harness.sendUserMessage("你好");

		const prompt = harness.lastMainTurnRequest()?.systemPrompt ?? "";
		expect(prompt).toContain("## Pipiclaw");
		expect(prompt).not.toContain("operating inside pi, a coding agent harness");
		expect(prompt).not.toContain("Pi documentation");

		// pi's tail is present, and the runtime boundary is appended after it and is last.
		const cwdAt = prompt.indexOf("Current working directory:");
		const boundaryAt = prompt.lastIndexOf("## Runtime Boundary");
		expect(cwdAt).toBeGreaterThan(-1);
		expect(boundaryAt).toBeGreaterThan(cwdAt);
		expect(prompt.trimEnd().length - boundaryAt).toBeLessThan(400);

		// Channel id / directory ride the turn, never the system prompt.
		expect(prompt).not.toContain(harness.channelId);
	});
});
