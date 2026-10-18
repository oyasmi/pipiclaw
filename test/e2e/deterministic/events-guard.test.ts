import { existsSync, readdirSync, readFileSync } from "fs";
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
		await harness.shutdown();
	});

	it("rejects an immediate event with an actionable error and writes nothing", async () => {
		// Catches tool/SDK wiring that persists a self-trigger or bubbles a recoverable refusal
		// to the user instead of returning it to the model. Domain-only validation cannot prove it.
		harness = await createDeterministicHarness();
		const eventsDir = join(harness.dotDir, "events");

		harness.model.script.route({
			name: "immediate-attempt",
			when: (r) => r.isMainTurn,
			respond: [
				reply.toolCall("event_manage", {
					action: "create",
					name: "e2e-immediate",
					definition: { type: "immediate", text: "loop me" },
				}),
				reply.text("收到拒绝，不再尝试。"),
			],
		});

		await harness.sendUserMessage("用 event_manage 建一个 immediate 事件");

		// The SDK must feed a recoverable tool error back to the model, not stop the turn.
		const followup = harness.mainTurnRequests().at(-1);
		const toolResult = (followup?.raw.messages as Array<{ role: string; content: string }>).find(
			(message) => message.role === "tool",
		);
		expect(toolResult?.content.length).toBeGreaterThan(0);
		const stored = readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.find((entry) => entry.message?.role === "toolResult" && entry.message?.toolName === "event_manage");
		expect(stored?.message).toMatchObject({ isError: false, details: { kind: "event_manage", recoverable: true } });
		expect(harness.deliveries.filter((d) => d.method === "sendPlain")).toHaveLength(1);

		// Nothing on disk.
		const files = existsSync(eventsDir) ? readdirSync(eventsDir) : [];
		expect(files.filter((f) => f.startsWith("e2e-immediate"))).toEqual([]);
	});
});
