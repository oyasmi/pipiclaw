import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness, writeWorkspaceFile } from "./helpers/runtime-harness.js";
import { canRunE2E } from "./helpers/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E("E2E: read tool", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("reads a workspace file and returns the unique marker", async () => {
		const marker = "E2E_READ_MARKER_8f31";
		const filePath = writeWorkspaceFile(harness, "fixtures/test-data.txt", marker);

		await harness.sendUserMessage(`请读取文件 ${filePath}，并只返回其中的唯一标记。`);

		const combinedText = harness.deliveries.map((delivery) => delivery.text ?? "").join("\n");
		expect(combinedText).toContain(marker);
		expect(harness.deliveries.some((delivery) => delivery.method === "sendPlain")).toBe(true);
	});
});
