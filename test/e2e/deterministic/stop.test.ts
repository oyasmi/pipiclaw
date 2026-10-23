import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRunner } from "../../../src/agent/channel-runner.js";
import type { DingTalkBot } from "../../../src/dingtalk/bot.js";
import * as apiKeys from "../../../src/models/api-keys.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: /stop", () => {
	let harness: DeterministicHarness;
	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.shutdown();
	});

	it("A5: /stop aborts the running turn and returns the channel to idle", async () => {
		// Mutation check: make handleStop a no-op and the channel stays busy — waitForIdle
		// after /stop times out.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "turn",
			when: (r) => r.isMainTurn && !r.lastUserText.includes("STILL_ALIVE"),
			respond: [reply.text("held then stopped")],
			repeat: true, // an aborted request may be retried by the client
		});
		const gate = harness.model.script.hold({ when: (r) => r.isMainTurn && !r.lastUserText.includes("STILL_ALIVE") });

		await harness.sendUserMessageNoWait("开始一个长任务");
		await gate.arrived;

		const before = harness.deliveries.length;
		await harness.sendUserMessageNoWait("/stop");
		try {
			// The provider is still held: finishing normally cannot masquerade as cancellation.
			await harness.waitForIdle();
			expect(harness.deliveries.slice(before).filter((d) => d.method === "sendPlain")).toHaveLength(1);
			expect(harness.deliveries.some((d) => (d.text ?? "").includes("held then stopped"))).toBe(false);
		} finally {
			gate.release();
		}
		// Also stop during backup credential resolution; an abort between requests must not revive the turn.
		// Spec 055 mutation (executed 2026-10-13; restored green): remove canRetry stop checks; backup provider count becomes 1.
		let entered!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const keyGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const getKey = apiKeys.getApiKeyForModel;
		vi.spyOn(apiKeys, "getApiKeyForModel").mockImplementation(async (registry, model) => {
			if (model.id === "mock-fallback") {
				entered();
				await keyGate;
			}
			return getKey(registry, model);
		});
		harness.model.script.failNext({ status: 429 });
		await harness.sendUserMessageNoWait("FAIL_THEN_STOP");
		await waiting;
		try {
			await harness.sendUserMessageNoWait("/stop");
		} finally {
			release();
		}
		await harness.waitForIdle();
		expect(harness.model.requests.filter((request) => request.model === "mock-fallback")).toHaveLength(0);
		vi.restoreAllMocks();

		// Channel is idle again and can take a fresh turn.
		harness.model.script.route({
			name: "next",
			when: (r) => r.isMainTurn && r.lastUserText.includes("STILL_ALIVE"),
			respond: [reply.text("yes, still here")],
		});
		await harness.sendUserMessage("STILL_ALIVE?");
		expect(harness.lastMainTurnRequest()?.matchedRoute).toBe("next");

		// A5 recovery extension: a settled SDK can still have a wedged transport callback.
		// Mutation (2026-10-22): remove resetChannelQueue from recovery; the real transport stays blocked and this case fails.
		let atEpilogue!: () => void;
		const epilogue = new Promise<void>((resolve) => {
			atEpilogue = resolve;
		});
		let releaseEpilogue!: () => void;
		const epilogueGate = new Promise<void>((resolve) => {
			releaseEpilogue = resolve;
		});
		let recovered!: () => void;
		const recovery = new Promise<void>((resolve) => {
			recovered = resolve;
		});
		const run = ChannelRunner.prototype.run;
		vi.spyOn(ChannelRunner.prototype, "run").mockImplementation(async function (this: ChannelRunner, ctx, store) {
			const result = await run.call(this, ctx, store);
			if (ctx.message.text === "WEDGE_RETURN") {
				atEpilogue();
				await epilogueGate;
			}
			return result;
		});
		const retire = ChannelRunner.prototype.retireForRecovery;
		vi.spyOn(ChannelRunner.prototype, "retireForRecovery").mockImplementation(function (this: ChannelRunner) {
			retire.call(this);
			recovered();
		});
		let oldTurn: Promise<void> = Promise.resolve();
		const handle = harness.runtime.handler.handleEvent.bind(harness.runtime.handler);
		vi.spyOn(harness.runtime.handler, "handleEvent").mockImplementation((event, bot, isEvent) => {
			const pending = handle(event, bot, isEvent);
			if (event.text === "WEDGE_RETURN") oldTurn = pending;
			return pending;
		});
		const nextGate = harness.model.script.hold({
			when: (request) => request.isMainTurn && request.lastUserText.includes("AFTER_RECOVERY"),
		});
		try {
			await harness.sendUserMessageNoWait("WEDGE_RETURN");
			await epilogue;
			await harness.sendUserMessageNoWait("/stop");
			await recovery;
			const bot = (harness.runtime as typeof harness.runtime & { bot: DingTalkBot }).bot;
			expect(bot.allChannelQueuesIdle()).toBe(true);
			await harness.sendUserMessageNoWait("AFTER_RECOVERY");
			const nextRequest = await nextGate.arrived;
			expect(JSON.stringify(nextRequest.messages)).toContain("WEDGE_RETURN");
			releaseEpilogue();
			await oldTurn;
			expect(harness.runtime.handler.isRunning(harness.channelId)).toBe(true);
		} finally {
			releaseEpilogue();
			nextGate.release();
		}
		await harness.waitForIdle();
	});
});
