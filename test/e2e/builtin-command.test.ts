import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness } from "./helpers/runtime-harness.js";
import { canRunE2E } from "./helpers/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E("E2E: built-in commands", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("handles /help via the runtime layer", async () => {
		await harness.sendUserMessage("/help");

		const finalText =
			[...harness.deliveries].reverse().find((delivery) => delivery.method === "sendPlain")?.text ?? "";
		expect(finalText).toContain("Slash Commands");
		expect(finalText).toContain("/steer <message>");
	});

	// Parity check with the TUI --print regression in tui.test.ts: /tasks resolves
	// zero-LLM on the DingTalk transport too. The exact deterministic renderer
	// string is the signal that this never reached the model.
	it("handles /tasks via the runtime layer without invoking the model", async () => {
		const deliveriesBefore = harness.deliveries.length;
		await harness.sendUserMessage("/tasks");

		const newDeliveries = harness.deliveries.slice(deliveriesBefore);
		expect(newDeliveries).toHaveLength(1);
		expect(newDeliveries[0]).toMatchObject({ method: "sendPlain", text: "# Tasks\n\nNo active tasks." });
	});
});
