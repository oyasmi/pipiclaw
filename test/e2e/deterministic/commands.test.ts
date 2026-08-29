import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	createDeterministicHarness,
	type DeterministicHarness,
	reply,
	writeWorkspaceSkill,
} from "../../support/runtime-harness.js";

/**
 * A1 / A2 / A3 (spec 048 D4). The command plane resolves entirely in the
 * transport + runner layers; the mock provider is the zero-LLM oracle — a slash
 * command that reaches it is a bug.
 */
describe("E2E deterministic: command plane", () => {
	let harness: DeterministicHarness;

	beforeAll(async () => {
		harness = await createDeterministicHarness();
		writeWorkspaceSkill(harness, "echoskill");
	});
	afterEach(() => harness.assertNoUnmatchedRequests());
	afterAll(() => harness.shutdown());

	it("A1: /help as the very first message does not crash the unready session", async () => {
		// Mutation check: remove `await this.ensureSessionReady()` from
		// handleBuiltinCommand and this reply becomes "命令执行失败：Cannot read
		// properties of undefined (reading 'promptTemplates')".
		await harness.sendUserMessage("/help");
		const reply1 = [...harness.deliveries].reverse().find((d) => d.method === "sendPlain")?.text ?? "";
		expect(reply1.length).toBeGreaterThan(0);
		expect(reply1).not.toContain("命令执行失败");
		expect(harness.modelRequestCount()).toBe(0);
	});

	it("A2: /tasks, /status, /memory status each reply with zero model requests", async () => {
		for (const command of ["/tasks", "/status", "/memory status"]) {
			const before = harness.deliveries.length;
			await harness.sendUserMessage(command);
			const replies = harness.deliveries.slice(before);
			expect(replies.length, `${command} should reply`).toBeGreaterThan(0);
			expect(replies.every((d) => !(d.text ?? "").includes("命令执行失败"))).toBe(true);
		}
		expect(harness.modelRequestCount()).toBe(0);
	});

	it("A3: an unknown /command is rejected zero-LLM; a known skill command enters a turn", async () => {
		// Mutation check: make isKnownSlashCommand return true unconditionally and the
		// first assertion flips — the typo becomes a full model turn.
		const beforeUnknown = harness.deliveries.length;
		await harness.sendUserMessage("/modle");
		const rejection = harness.deliveries.slice(beforeUnknown);
		expect(rejection).toHaveLength(1);
		expect(harness.modelRequestCount()).toBe(0);

		harness.model.script.route({
			name: "skill-turn",
			when: (req) => req.isMainTurn,
			respond: [reply.text("done via skill")],
		});
		await harness.sendUserMessage("/skill:echoskill");
		expect(harness.modelRequestCount()).toBeGreaterThan(0);
		expect(harness.model.requests.some((r) => r.matchedRoute === "skill-turn")).toBe(true);
	});
});
