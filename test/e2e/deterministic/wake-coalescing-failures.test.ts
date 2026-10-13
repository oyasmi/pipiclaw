import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelRunner } from "../../../src/agent/channel-runner.js";
import { TurnPipeline } from "../../../src/agent/turn/turn-pipeline.js";
import type { ChannelEvent } from "../../../src/channel/channel-event.js";
import { type DurableDispatchRecord, DurableDispatchService } from "../../../src/runtime/durable-dispatch.js";
import * as atomicFile from "../../../src/shared/atomic-file.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("E2E deterministic: completion-wake failure boundaries", () => {
	let harness: DeterministicHarness | undefined;
	afterEach(async () => {
		vi.restoreAllMocks();
		if (harness) {
			await harness.shutdown();
		}
		harness = undefined;
	});

	function seedWakes(current: DeterministicHarness): ChannelEvent[] {
		const dir = join(current.homeDir, "state", "dispatch");
		mkdirSync(dir, { recursive: true });
		return ["run_a", "run_b", "run_c"].map((runId, index) => {
			const dispatchId = `subagent:${current.channelId}:${runId}:done`;
			const event: ChannelEvent = {
				type: "dm",
				channelId: current.channelId,
				ts: String(index),
				user: "SUBAGENT",
				userName: "SUBAGENT",
				text: `[SUBAGENT:${runId}] finished`,
				conversationId: "conv_e2e",
				conversationType: "1",
				dispatchId,
			};
			const record: DurableDispatchRecord = {
				version: 1,
				id: dispatchId,
				event,
				status: "queued",
				deliveries: 1,
				createdAt: new Date(index).toISOString(),
				leaseExpiresAt: new Date(Date.now() + 900_000).toISOString(),
			};
			writeFileSync(join(dir, `${encodeURIComponent(dispatchId)}.json`), JSON.stringify(record));
			return event;
		});
	}

	it("keeps stopped merged notifications on disk and redelivers them through the real queue", async () => {
		// Catches /stop's reset followed by an unconditional merged-wake markCompleted deleting
		// unhandled notifications. Mutation check (executed against HEAD 0e9d345): the disk assertion fails.
		harness = await createDeterministicHarness();
		const current = harness;
		const wakes = seedWakes(current);
		const entered = barrier();
		current.model.script.route({
			name: "wake",
			when: (request) => request.isMainTurn,
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});
		const gate = current.model.script.hold({
			when: (request) => {
				if (!request.isMainTurn) return false;
				entered.resolve();
				return true;
			},
		});
		let durable!: DurableDispatchService;
		const originalStart = DurableDispatchService.prototype.markStarted;
		vi.spyOn(DurableDispatchService.prototype, "markStarted").mockImplementation(function (
			this: DurableDispatchService,
			id,
		) {
			durable = this;
			return originalStart.call(this, id);
		});
		const reset = barrier();
		const originalCancel = DurableDispatchService.prototype.cancelChannel;
		vi.spyOn(DurableDispatchService.prototype, "cancelChannel").mockImplementation(async function (
			this: DurableDispatchService,
			channelId,
		) {
			try {
				return await originalCancel.call(this, channelId);
			} finally {
				reset.resolve();
			}
		});
		for (const wake of wakes) expect(current.enqueueWake(wake.text, wake)).toBe(true);
		await entered.promise;
		expect(current.lastMainTurnRequest()?.lastUserText).toContain("[SUBAGENT:run_b]");
		expect(current.lastMainTurnRequest()?.lastUserText).toContain("[SUBAGENT:run_c]");
		await current.sendUserMessageNoWait("/stop");
		await reset.promise;
		gate.release();
		await current.waitForIdle();
		const dir = join(current.homeDir, "state", "dispatch");
		const remaining = readdirSync(dir).map((name) => decodeURIComponent(name));
		for (const wake of wakes.slice(1)) expect(remaining).toContain(`${wake.dispatchId}.json`);
		const before = current.mainTurnRequests().length;
		// Drive the actual outbox past the retry backoff; no timer wait or restart is needed.
		await durable.drainOnce(Date.now() + 31_000);
		await current.waitForIdle();
		const replayed = current.mainTurnRequests().slice(before);
		expect(replayed.length).toBeGreaterThan(0);
		for (const id of ["run_b", "run_c"]) {
			expect(replayed.some((request) => request.lastUserText.includes(`[SUBAGENT:${id}]`))).toBe(true);
		}
		expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
	});

	it.each([
		["the turn settles before /stop's reset runs", "late"],
		["/stop's reset fails", "fail"],
	] as const)("redelivers stopped merged notifications on the first drain when %s", async (_name, mode) => {
		// Catches markRetryable leaving the absorbed stale-delivery mark behind: with the reset late
		// or failed, the first redelivery was turned away by markStarted until the 15 minute lease.
		harness = await createDeterministicHarness();
		const current = harness;
		const wakes = seedWakes(current);
		const entered = barrier();
		const resetMayRun = barrier();
		current.model.script.route({
			name: "wake",
			when: (request) => request.isMainTurn,
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});
		const gate = current.model.script.hold({
			when: (request) => {
				if (!request.isMainTurn) return false;
				entered.resolve();
				return true;
			},
		});
		let durable!: DurableDispatchService;
		const originalStart = DurableDispatchService.prototype.markStarted;
		vi.spyOn(DurableDispatchService.prototype, "markStarted").mockImplementation(function (
			this: DurableDispatchService,
			id,
		) {
			durable = this;
			return originalStart.call(this, id);
		});
		const originalCancel = DurableDispatchService.prototype.cancelChannel;
		vi.spyOn(DurableDispatchService.prototype, "cancelChannel").mockImplementation(async function (
			this: DurableDispatchService,
			channelId,
		) {
			if (mode === "fail") throw new Error("injected reset failure");
			await resetMayRun.promise;
			return originalCancel.call(this, channelId);
		});
		for (const wake of wakes) expect(current.enqueueWake(wake.text, wake)).toBe(true);
		await entered.promise;
		await current.sendUserMessageNoWait("/stop");
		gate.release();
		await current.waitForIdle();
		const dir = join(current.homeDir, "state", "dispatch");
		const readStatuses = () =>
			wakes.slice(1).map((wake) => {
				const raw = readFileSync(join(dir, `${encodeURIComponent(wake.dispatchId!)}.json`), "utf-8");
				return (JSON.parse(raw) as DurableDispatchRecord).status;
			});
		// The turn finished first: the records are already pending and the reset (if any) saw nothing to do.
		expect(readStatuses()).toEqual(["pending", "pending"]);
		resetMayRun.resolve();
		await current.waitForIdle();
		const before = current.mainTurnRequests().length;
		await durable.drainOnce(Date.now() + 31_000);
		await current.waitForIdle();
		const replayed = current.mainTurnRequests().slice(before);
		for (const id of ["run_b", "run_c"]) {
			expect(replayed.some((request) => request.lastUserText.includes(`[SUBAGENT:${id}]`))).toBe(true);
		}
		expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
	});

	it.each([
		["after markStarted, before absorbPending starts", "before-scan"],
		["while absorbPending is still scanning candidates", "mid-scan"],
		["between the claim write and publishing the stale-delivery mark", "after-write"],
	] as const)(
		"redelivers merged notifications on the first drain when /stop lands %s and its reset fails",
		async (_name, point) => {
			// Catches an admission that began before /stop cleared the queued closures still publishing
			// absorbed stale-delivery marks: with cancelChannel failing, the first drain was turned away at
			// markStarted until the 15 minute lease. The stop fact must come from admission entry, not from
			// a sample taken inside absorbPending.
			harness = await createDeterministicHarness();
			const current = harness;
			const wakes = seedWakes(current);
			const parked = barrier();
			const gate = barrier();
			let armed = false;
			let hit = false;
			const park = async () => {
				if (hit) return;
				hit = true;
				parked.resolve();
				await gate.promise;
			};
			current.model.script.route({
				name: "wake",
				when: (request) => request.isMainTurn,
				respond: [reply.text("[SILENT]")],
				repeat: true,
			});
			let durable!: DurableDispatchService;
			const originalStart = DurableDispatchService.prototype.markStarted;
			vi.spyOn(DurableDispatchService.prototype, "markStarted").mockImplementation(async function (
				this: DurableDispatchService,
				id,
			) {
				durable = this;
				const started = await originalStart.call(this, id);
				if (point === "before-scan" && id === wakes[0]!.dispatchId) await park();
				return started;
			});
			const originalAbsorb = DurableDispatchService.prototype.absorbPending;
			vi.spyOn(DurableDispatchService.prototype, "absorbPending").mockImplementation(function (
				this: DurableDispatchService,
				...args
			) {
				armed = true;
				return originalAbsorb.apply(this, args);
			});
			const priv = DurableDispatchService.prototype as unknown as {
				read: (id: string) => Promise<DurableDispatchRecord | undefined>;
			};
			const originalRead = priv.read;
			vi.spyOn(priv, "read").mockImplementation(async function (this: DurableDispatchService, id: string) {
				const record = await originalRead.call(this, id);
				if (point === "mid-scan" && armed) await park();
				return record;
			});
			const write = atomicFile.writeFileAtomically;
			vi.spyOn(atomicFile, "writeFileAtomically").mockImplementation(async (path, content, options) => {
				await write(path, content, options);
				if (
					point === "after-write" &&
					path.endsWith(`${encodeURIComponent(wakes[1]!.dispatchId!)}.json`) &&
					JSON.parse(String(content)).status === "running"
				)
					await park();
			});
			vi.spyOn(DurableDispatchService.prototype, "cancelChannel").mockRejectedValue(
				new Error("injected reset failure"),
			);
			for (const wake of wakes) expect(current.enqueueWake(wake.text, wake)).toBe(true);
			await parked.promise;
			await current.sendUserMessageNoWait("/stop");
			gate.resolve();
			await current.waitForIdle();
			const dir = join(current.homeDir, "state", "dispatch");
			const before = current.mainTurnRequests().length;
			await durable.drainOnce(Date.now() + 31_000);
			await current.waitForIdle();
			const replayed = current.mainTurnRequests().slice(before);
			for (const id of ["run_b", "run_c"]) {
				expect(replayed.some((request) => request.lastUserText.includes(`[SUBAGENT:${id}]`))).toBe(true);
			}
			expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
		},
	);

	it("redelivers stopped merged notifications when the watchdog force-releases the turn before it finishes", async () => {
		// Catches reading the stop fact off the live turn state: forceEnd() swaps in an idle handle
		// (stopRequested=false) before the old finishTurn runs, and with /stop's reset failing the
		// absorbed stale-delivery marks were kept, so the first drain was turned away at markStarted.
		harness = await createDeterministicHarness();
		const current = harness;
		const wakes = seedWakes(current);
		const entered = barrier();
		current.model.script.route({
			name: "wake",
			when: (request) => request.isMainTurn,
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});
		const gate = current.model.script.hold({
			when: (request) => {
				if (!request.isMainTurn) return false;
				entered.resolve();
				return true;
			},
		});
		let durable!: DurableDispatchService;
		const originalStart = DurableDispatchService.prototype.markStarted;
		vi.spyOn(DurableDispatchService.prototype, "markStarted").mockImplementation(function (
			this: DurableDispatchService,
			id,
		) {
			durable = this;
			return originalStart.call(this, id);
		});
		vi.spyOn(DurableDispatchService.prototype, "cancelChannel").mockRejectedValue(
			new Error("injected reset failure"),
		);
		let runner: ChannelRunner | undefined;
		const originalStop = ChannelRunner.prototype.requestStop;
		vi.spyOn(ChannelRunner.prototype, "requestStop").mockImplementation(function (this: ChannelRunner) {
			runner = this;
			return originalStop.call(this);
		});
		// The watchdog fires while the old turn is still inside finishTurn, before it reads stopRequested.
		const originalCompleted = DurableDispatchService.prototype.markCompleted;
		vi.spyOn(DurableDispatchService.prototype, "markCompleted").mockImplementation(async function (
			this: DurableDispatchService,
			id,
		) {
			if (runner?.getTurnStatus().stopRequested) expect(runner.forceEndTurn("test watchdog")).toBe(true);
			return originalCompleted.call(this, id);
		});
		for (const wake of wakes) expect(current.enqueueWake(wake.text, wake)).toBe(true);
		await entered.promise;
		await current.sendUserMessageNoWait("/stop");
		gate.release();
		await current.waitForIdle();
		expect(runner?.getTurnStatus().stopRequested).toBe(false);
		const dir = join(current.homeDir, "state", "dispatch");
		const before = current.mainTurnRequests().length;
		await durable.drainOnce(Date.now() + 31_000);
		await current.waitForIdle();
		const replayed = current.mainTurnRequests().slice(before);
		for (const id of ["run_b", "run_c"]) {
			expect(replayed.some((request) => request.lastUserText.includes(`[SUBAGENT:${id}]`))).toBe(true);
		}
		expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
	});

	it("keeps merged notifications for redelivery when the agent run returns an error", async () => {
		// Catches a returned stopReason "error" (preparation threw before the model saw the merged
		// text) being treated as handled, which deleted the absorbed records.
		harness = await createDeterministicHarness();
		const current = harness;
		const wakes = seedWakes(current);
		current.model.script.route({
			name: "wake",
			when: (request) => request.isMainTurn,
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});
		let durable!: DurableDispatchService;
		const originalStart = DurableDispatchService.prototype.markStarted;
		vi.spyOn(DurableDispatchService.prototype, "markStarted").mockImplementation(function (
			this: DurableDispatchService,
			id,
		) {
			durable = this;
			return originalStart.call(this, id);
		});
		vi.spyOn(TurnPipeline.prototype, "prepareTurnImages").mockRejectedValueOnce(
			new Error("injected prepare failure"),
		);
		for (const wake of wakes) expect(current.enqueueWake(wake.text, wake)).toBe(true);
		await current.waitForIdle();
		expect(current.mainTurnRequests()).toHaveLength(0);
		const dir = join(current.homeDir, "state", "dispatch");
		const remaining = readdirSync(dir).map((name) => decodeURIComponent(name));
		for (const wake of wakes.slice(1)) expect(remaining).toContain(`${wake.dispatchId}.json`);
		// Non-stop failure: the old queued closures are still alive and must stay deduplicated, so
		// the notifications run once each after the backoff.
		await durable.drainOnce(Date.now() + 31_000);
		await current.waitForIdle();
		const text = current.mainTurnRequests().map((request) => request.lastUserText);
		for (const id of ["run_b", "run_c"]) {
			expect(text.filter((value) => value.includes(`[SUBAGENT:${id}]`))).toHaveLength(1);
		}
		expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toEqual([]);
	});

	it("settles earlier merged notifications when a later claim write fails, then runs the failed wake separately", async () => {
		// Catches a later write rejecting absorbPending and losing earlier live claims.
		// Mutation check (executed against HEAD 0e9d345): the expected second provider request is absent.
		harness = await createDeterministicHarness();
		const current = harness;
		const wakes = seedWakes(current);
		current.model.script.route({
			name: "wake",
			when: (request) => request.isMainTurn,
			respond: [reply.text("[SILENT]")],
			repeat: true,
		});
		const write = atomicFile.writeFileAtomically;
		let injected = 0;
		vi.spyOn(atomicFile, "writeFileAtomically").mockImplementation(async (path, content, options) => {
			if (
				injected === 0 &&
				path.endsWith(`${encodeURIComponent(wakes[2]!.dispatchId!)}.json`) &&
				JSON.parse(String(content)).status === "running"
			) {
				injected++;
				throw new Error("injected ENOSPC on third wake claim");
			}
			await write(path, content, options);
		});
		for (const wake of wakes) expect(current.enqueueWake(wake.text, wake)).toBe(true);
		await current.waitForIdle();
		expect(injected).toBe(1);
		const requests = current.mainTurnRequests();
		expect(requests).toHaveLength(2);
		expect(requests[0]?.lastUserText).toContain("[SUBAGENT:run_b]");
		expect(requests[1]?.lastUserText).toContain("[SUBAGENT:run_c]");
		expect(readdirSync(join(current.homeDir, "state", "dispatch")).filter((name) => name.endsWith(".json"))).toEqual(
			[],
		);
	});
});
