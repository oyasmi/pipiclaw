import { existsSync, readFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness, getChannelFile } from "./helpers/runtime-harness.js";
import { canRunE2E, getE2ESkipReason } from "./helpers/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E("E2E: basic conversation", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("completes a basic user message through the runtime entrypoint", async () => {
		await harness.sendUserMessage("你好，请用一句简短的话回复，并说明你已经收到消息。");

		const finalDelivery = [...harness.deliveries]
			.reverse()
			.find(
				(delivery) =>
					delivery.method === "sendPlain" ||
					delivery.method === "finalizeCard" ||
					delivery.method === "finalizeExistingCard",
			);
		expect(finalDelivery?.text?.trim().length ?? 0, getE2ESkipReason() ?? undefined).toBeGreaterThan(0);

		const logPath = getChannelFile(harness, "log.jsonl");
		const contextPath = getChannelFile(harness, "context.jsonl");
		expect(existsSync(logPath)).toBe(true);
		expect(existsSync(contextPath)).toBe(true);
		expect(readFileSync(logPath, "utf-8")).toContain("已经收到");
	});
});
