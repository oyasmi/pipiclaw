import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

/**
 * event_manage's self-triggering-loop guard (spec 048 D5, from events-guard).
 * Deterministic half: the immediate-event tool call is rejected with an
 * actionable message and nothing lands on disk. The prompt-level "don't even
 * try" guidance is a model-behaviour concern and lives in live B3 / evals.
 */
describe("E2E deterministic: event_manage guards", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	it("rejects an immediate event with an actionable error and writes nothing", async () => {
		harness = await createDeterministicHarness();
		const eventsDir = join(harness.workspaceDir, "events");

		harness.model.script.route({
			name: "immediate-attempt",
			when: (r) => r.isMainTurn,
			respond: [
				reply.toolCall("event_manage", {
					action: "create",
					name: "e2e-immediate",
					definition: JSON.stringify({ type: "immediate", text: "loop me", channelId: harness.channelId }),
				}),
				reply.text("收到拒绝，不再尝试。"),
			],
		});

		await harness.sendUserMessage("用 event_manage 建一个 immediate 事件");

		// The tool result fed back to the model on the 2nd request carries the guard message.
		const followup = harness.mainTurnRequests().at(-1);
		expect(JSON.stringify(followup?.messages)).toContain("self-triggering loop guard");

		// Nothing on disk.
		const files = existsSync(eventsDir) ? readdirSync(eventsDir) : [];
		expect(files.filter((f) => f.startsWith("e2e-immediate"))).toEqual([]);
	});
});
