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
});
