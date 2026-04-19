import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness, getChannelFile } from "./helpers/runtime-harness.js";
import { canRunE2E } from "./helpers/setup.js";
import { waitForFileContent } from "./helpers/wait.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

describeE2E("E2E: session memory", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness({
			startServices: true,
			memoryMaintenanceSchedulerIntervalMs: 2_000,
		});
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("updates SESSION.md beyond the default template", async () => {
		await harness.sendUserMessage("请记住当前任务代号 SESSION-E2E-ALPHA，并简短总结这项工作。");

		const sessionContent = await waitForFileContent(
			getChannelFile(harness, "SESSION.md"),
			(content) => !content.includes("<!--") && content.trim().length > 0,
			{ timeoutMs: 45_000, intervalMs: 750 },
		);

		expect(sessionContent).toContain("# Current State");
		expect(sessionContent).not.toContain("<!--");
	});
});
