import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRunner } from "../../../src/agent/channel-runner.js";
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
		vi.spyOn(ChannelRunner.prototype, "run").mockImplementation(async function (
			this: ChannelRunner,
			info,
			ctx,
			store,
		) {
			const result = await run.call(this, info, ctx, store);
			if (info.text === "WEDGE_RETURN") {
				atEpilogue();
				await epilogueGate;
			}
			return result;
		});
		// Mutation 2026-11-08: unconditional old-watchdog cleanup prevents B recovery (confirmed red at a reduced 12s test deadline).
		// A→B regression: A's notification is held while B is stopped. Releasing A then
		// must not remove B's watchdog. Both provider and notification windows are test-owned.
		let releaseNotice!: () => void;
		const noticeGate = new Promise<void>((resolve) => {
			releaseNotice = resolve;
		});
		let noticeEntered!: () => void;
		const noticeArrival = new Promise<void>((resolve) => {
			noticeEntered = resolve;
		});
		let retiredB!: () => void;
		const recoveryB = new Promise<void>((resolve) => {
			retiredB = resolve;
		});
		let retireCount = 0;
		let noticeHeld = false;
		const transport = harness.runtime.transports.forChannel(harness.channelId)!;
		const push = transport.push.bind(transport);
		vi.spyOn(transport, "push").mockImplementation(async (channel, message) => {
			const sent = await push(channel, message);
			if (retireCount === 1 && !noticeHeld) {
				noticeHeld = true;
				noticeEntered();
				await noticeGate;
			}
			return sent;
		});
		const abort = ChannelRunner.prototype.abort;
		vi.spyOn(ChannelRunner.prototype, "abort").mockImplementation(function (this: ChannelRunner) {
			return this.getTurnStatus().taskText === "AFTER_RECOVERY" ? new Promise<void>(() => {}) : abort.call(this);
		});
		const retire = ChannelRunner.prototype.retireForRecovery;
		vi.spyOn(ChannelRunner.prototype, "retireForRecovery").mockImplementation(function (this: ChannelRunner) {
			retire.call(this);
			retireCount++;
			if (retireCount === 1) recovered();
			else retiredB();
		});
		let oldTurn: Promise<void> = Promise.resolve();
		let newTurn: Promise<void> = Promise.resolve();
		const handle = harness.runtime.ingress.handleEvent.bind(harness.runtime.ingress);
		vi.spyOn(harness.runtime.ingress, "handleEvent").mockImplementation((event) => {
			const pending = handle(event);
			if (event.text === "WEDGE_RETURN") oldTurn = pending;
			if (event.text === "AFTER_RECOVERY") newTurn = pending;
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
			await noticeArrival;
			expect(harness.runtime.ingress.isIdle()).toBe(true);
			await harness.sendUserMessageNoWait("AFTER_RECOVERY");
			const nextRequest = await nextGate.arrived;
			expect(JSON.stringify(nextRequest.messages)).toContain("WEDGE_RETURN");
			releaseEpilogue();
			await oldTurn;
			expect(harness.runtime.ingress.isRunning(harness.channelId)).toBe(true);
			await harness.sendUserMessageNoWait("/stop");
			releaseNotice();
			await recoveryB;
			expect(retireCount).toBe(2);
			expect(harness.runtime.ingress.isIdle()).toBe(true);
			nextGate.release();
			await newTurn;
		} finally {
			releaseNotice();
			releaseEpilogue();
			nextGate.release();
		}
		await harness.waitForIdle();
	});
});
