import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getSkillRoots } from "../../../src/skills/roots.js";
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
		writeWorkspaceSkill(harness, "echoskill", "WORKSPACE_COMMAND_063");
		const dir = join(getSkillRoots(harness.workspaceDir)[1].dir, "echoskill");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			"---\nname: echoskill\ndescription: shared duplicate\n---\n\nSHARED_COMMAND_063",
		);
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
		expect(reply1).toContain("/new");
		expect(reply1).toContain("/stop");
		expect(harness.modelRequestCount()).toBe(0);
	});

	it("A2: report commands reply and event deletion persists with zero model requests", async () => {
		// Catches a missing command route, including the events wiring formerly checked by a
		// separate runtime-context unit test. Mutation check (2026-10-13): replacing the router's
		// events handler with an empty reply leaves this file present and makes A2 fail.
		for (const command of ["/tasks", "/status", "/memory status", "/session"]) {
			const before = harness.deliveries.length;
			await harness.sendUserMessage(command);
			const replies = harness.deliveries.slice(before);
			expect(replies.length, `${command} should reply`).toBeGreaterThan(0);
		}
		mkdirSync(join(harness.deskDir, "events"), { recursive: true });
		const eventPath = join(harness.deskDir, "events", "command-plane-probe.json");
		writeFileSync(
			eventPath,
			JSON.stringify({
				type: "periodic",
				channelId: harness.channelId,
				text: "probe",
				schedule: "0 9 * * 1",
			}),
		);
		await harness.sendUserMessage("/events delete command-plane-probe");
		expect(existsSync(eventPath)).toBe(false);
		expect(harness.modelRequestCount()).toBe(0);
	});

	it("A3: an unknown /command is rejected zero-LLM; a known skill command enters a turn", async () => {
		// Mutation check: make isKnownSlashCommand return true unconditionally and the
		// first assertion flips — the typo becomes a full model turn. Spec 063 mutation check
		// (2026-10-27): reversing source precedence substitutes SHARED_COMMAND_063; this case fails.
		const beforeUnknown = harness.deliveries.length;
		await harness.sendUserMessage("/modle");
		// discardCard is the turn-close bookkeeping every turn now emits, not a reply.
		const rejection = harness.deliveries.slice(beforeUnknown).filter((d) => d.method !== "discardCard");
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
		const input = JSON.stringify(harness.lastMainTurnRequest()!.messages);
		expect(input).toContain("WORKSPACE_COMMAND_063");
		expect(input).not.toContain("SHARED_COMMAND_063");
	});
});
