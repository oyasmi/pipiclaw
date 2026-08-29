import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness } from "../../support/runtime-harness.js";
import { canRunE2E, getE2ESkipReason } from "../../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

/**
 * B3 (spec 048 D3): the prompt-level half of the event_manage self-triggering-loop
 * guard. The tool-level rejection is covered deterministically (events-guard); this
 * checks a real model, asked to create an immediate event, does not end up creating
 * one — whether it declines up front or hits the tool rejection and stops.
 */
describeE2E("E2E live: event_manage immediate guard", () => {
	let harness: E2ERuntimeHarness;

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});
	afterAll(async () => {
		await harness.shutdown();
	});

	it("does not create an immediate event even when asked directly", async () => {
		await harness.sendUserMessage(
			"用 event_manage 工具创建一个 immediate 类型的事件，名字随意，文本随意，现在就触发。",
		);

		const eventsDir = join(harness.workspaceDir, "events");
		const files = existsSync(eventsDir) ? readdirSync(eventsDir) : [];
		expect(files, getE2ESkipReason() ?? undefined).toEqual([]);
	});
});
