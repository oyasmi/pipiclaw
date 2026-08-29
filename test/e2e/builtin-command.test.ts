import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness } from "../support/runtime-harness.js";
import { canRunE2E } from "../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

// Built-in slash commands (/help, /tasks, unknown /xxx) resolve entirely in the
// transport + runner layers and never reach the model, so these assertions are
// already deterministic. They exist to lock two things spec 048 flagged:
//   F2  — /help as the very first message for a fresh channel used to crash
//         (`this.session` undefined while initializeSession was still running).
//   F1  — the old assertions pinned literal renderer strings, so an intentional
//         copy edit turned the suite red and masked the F2 crash for 5 days.
// Mutation check (F2): revert channel-runner's `await this.ensureSessionReady()`
// in handleBuiltinCommand and the first `/help` case goes red with
// "命令执行失败：Cannot read properties of undefined (reading 'promptTemplates')".
describeE2E("E2E: built-in commands", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("answers /help sent as the very first message without crashing (F2 regression)", async () => {
		await harness.sendUserMessage("/help");

		const reply = [...harness.deliveries].reverse().find((delivery) => delivery.method === "sendPlain")?.text ?? "";
		expect(reply.length).toBeGreaterThan(0);
		expect(reply).not.toContain("命令执行失败");
	});

	it("rejects an unknown slash command as the first message without invoking the model", async () => {
		const before = harness.deliveries.length;
		await harness.sendUserMessage("/modle");

		const created = harness.deliveries.slice(before);
		expect(created).toHaveLength(1);
		expect(created[0]?.method).toBe("sendPlain");
		expect(created[0]?.text ?? "").not.toContain("命令执行失败");
	});

	it("resolves /tasks in the runner layer with a single deterministic reply", async () => {
		const before = harness.deliveries.length;
		await harness.sendUserMessage("/tasks");

		const created = harness.deliveries.slice(before);
		expect(created).toHaveLength(1);
		expect(created[0]).toMatchObject({ method: "sendPlain" });
		// Report shape, not a copy of the string: an empty-state report leads with the
		// bold headline (AGENTS.md "Command Reply Conventions" §3/§6). A model paraphrase
		// of "/tasks" would not.
		expect(created[0]?.text?.startsWith("**任务**")).toBe(true);
	});
});
