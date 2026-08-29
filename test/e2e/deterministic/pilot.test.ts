import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

/**
 * Pilot for the deterministic e2e layer (spec 048 P1). No network, no API cost —
 * the model is the in-process mock provider. Proves the shape:
 *   1. the whole runtime boots and serves turns against the mock, offline;
 *   2. `model.requests` is the zero-LLM oracle — a slash command must not reach it;
 *   3. an unmatched provider request fails the test loudly (afterEach).
 *
 * Mutation check (A2): route `/tasks` through dispatch to the model instead of the
 * runner (delete the `isRunnerBuiltInCommand` branch in bootstrap) and
 * `modelRequestCount()` jumps above 0 here.
 */
describe("E2E deterministic: pilot", () => {
	let harness: DeterministicHarness;

	beforeAll(async () => {
		harness = await createDeterministicHarness();
	});
	afterEach(() => {
		harness.assertNoUnmatchedRequests();
	});
	afterAll(async () => {
		await harness.shutdown();
	});

	it("A2: built-in slash commands each reply without any model request", async () => {
		for (const command of ["/help", "/tasks", "/status"]) {
			const before = harness.deliveries.length;
			await harness.sendUserMessage(command);
			const replies = harness.deliveries.slice(before);
			expect(replies.length, `${command} should reply`).toBeGreaterThan(0);
			expect(replies.every((d) => !(d.text ?? "").includes("命令执行失败"))).toBe(true);
		}
		// The real oracle: a slash command must never reach the model.
		expect(harness.modelRequestCount()).toBe(0);
	});

	it("runs a normal turn through the mock provider and delivers the scripted reply", async () => {
		harness.model.script.route({
			name: "pilot-turn",
			when: (req) => req.isMainTurn && req.lastUserText.includes("E2E_PILOT_PING"),
			respond: [reply.text("收到 E2E_PILOT_PONG")],
		});

		const before = harness.modelRequestCount();
		await harness.sendUserMessage("说 E2E_PILOT_PING");

		const text = harness.deliveries.map((d) => d.text ?? "").join("\n");
		expect(text).toContain("E2E_PILOT_PONG");
		expect(harness.modelRequestCount()).toBeGreaterThan(before);
		expect(harness.model.requests.some((r) => r.matchedRoute === "pilot-turn")).toBe(true);
	});
});
