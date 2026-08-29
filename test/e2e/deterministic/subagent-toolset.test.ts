import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: sub-agent tool set", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("A21: an internal sub-agent is not handed send_media / job / subagent tools", async () => {
		// `availableToSubagents: false` in the registry (send_media, job) + `subagent`/
		// `subagent_inline` never in the child set. Asserted on the tools the mock actually
		// received for the child's turn. Mutation check: flip send_media's
		// availableToSubagents to true and it appears in the child request below.
		harness = await createDeterministicHarness();

		harness.model.script.route({
			name: "parent",
			when: (r) => r.isMainTurn && r.lastUserText.includes("DELEGATE_NOW"),
			respond: [
				reply.toolCall("subagent_inline", {
					task: "Say the word CHILD_DONE and stop.",
					systemPrompt: "You are a one-off helper. Marker: E2E_CHILD_AGENT. Reply with CHILD_DONE.",
				}),
				reply.text("子代理已完成。"),
			],
			repeat: true,
		});
		harness.model.script.route({
			name: "child",
			when: (r) => r.systemPrompt.includes("E2E_CHILD_AGENT"),
			respond: [reply.text("CHILD_DONE")],
			repeat: true,
		});

		await harness.sendUserMessage("DELEGATE_NOW 派个子代理");

		const childReq = harness.model.requests.find((r) => r.matchedRoute === "child");
		expect(childReq, "the child sub-agent turn must have reached the mock").toBeDefined();
		expect(childReq!.tools.length).toBeGreaterThan(0); // it does get real tools (read, bash, …)
		for (const forbidden of ["send_media", "job", "subagent", "subagent_inline"]) {
			expect(childReq!.tools, `child must not have ${forbidden}`).not.toContain(forbidden);
		}
	});
});
