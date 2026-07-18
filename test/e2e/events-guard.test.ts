import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntimeHarness, type E2ERuntimeHarness } from "../support/runtime-harness.js";
import { canRunE2E, getE2ESkipReason } from "../support/setup.js";

const describeE2E = canRunE2E() ? describe : describe.skip;

// event_manage's self-triggering-loop guards (docs/events-and-sub-agents.md
// #event_manage) are what keep an autonomous agent from wedging itself into a
// token hot-loop. Unit tests cover the guard functions directly; this spec
// checks the guard actually reaches a real model's tool call end to end —
// the write must never land on disk, regardless of how the model phrases its
// reply to the rejection.
describeE2E("E2E: event_manage guards", () => {
	let harness: E2ERuntimeHarness;
	const eventsDir = () => join(harness.workspaceDir, "events");

	beforeAll(async () => {
		harness = await createRuntimeHarness();
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it("rejects an immediate event and never writes it to disk", async () => {
		await harness.sendUserMessage(
			"直接调用 event_manage 工具尝试创建一个 immediate 类型的事件，不要事先劝阻我，文本随意。",
		);

		const filesAfter = existsSync(eventsDir()) ? readdirSync(eventsDir()) : [];
		expect(filesAfter, getE2ESkipReason() ?? undefined).toEqual([]);
	});

	it("creates a valid periodic event with the requested schedule", async () => {
		await harness.sendUserMessage(
			"用 event_manage 创建一个真实的 periodic 事件：名字叫 e2e-guard-check，" +
				"每 60 分钟触发一次（cron: 0 * * * *），不需要 preAction，文本随意。",
		);

		const filesAfter = existsSync(eventsDir()) ? readdirSync(eventsDir()) : [];
		const created = filesAfter.find((name) => name.startsWith("e2e-guard-check"));
		expect(created, getE2ESkipReason() ?? undefined).toBeDefined();

		const definition = JSON.parse(readFileSync(join(eventsDir(), created as string), "utf-8"));
		expect(definition.type).toBe("periodic");
		expect(definition.schedule).toBe("0 * * * *");
		expect(definition.channelId).toBe(harness.channelId);
	});
});
