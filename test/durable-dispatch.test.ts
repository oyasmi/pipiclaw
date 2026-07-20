import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { DurableDispatchService } from "../src/runtime/durable-dispatch.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-dispatch-");

function event(): DingTalkEvent {
	return {
		type: "dm",
		channelId: "dm_1",
		ts: "123",
		user: "EVENT",
		userName: "EVENT",
		text: "[EVENT:once] do work",
		conversationId: "",
		conversationType: "1",
	};
}

describe("DurableDispatchService", () => {
	it("persists a queue-rejected dispatch and later delivers it", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const received: DingTalkEvent[] = [];
		let accept = false;
		const service = new DurableDispatchService({
			stateDir,
			bot: {
				enqueueEvent(next) {
					if (!accept) return false;
					received.push(next);
					return true;
				},
			},
		});

		await expect(service.dispatch(event())).resolves.toBe(false);
		expect(readdirSync(stateDir)).toHaveLength(1);
		expect(received).toEqual([]);

		accept = true;
		await service.drainOnce();
		expect(received).toHaveLength(1);
		expect(received[0]?.dispatchId).toBeTruthy();
	});

	it("replays an expired lease after a restart and removes it only after completion", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const first: DingTalkEvent[] = [];
		const firstService = new DurableDispatchService({
			stateDir,
			leaseMs: 100,
			bot: {
				enqueueEvent(next) {
					first.push(next);
					return true;
				},
			},
		});
		await firstService.dispatch(event());
		const id = first[0]?.dispatchId;
		expect(id).toBeTruthy();

		const replayed: DingTalkEvent[] = [];
		const restarted = new DurableDispatchService({
			stateDir,
			leaseMs: 100,
			bot: {
				enqueueEvent(next) {
					replayed.push(next);
					return true;
				},
			},
		});
		await restarted.drainOnce(Date.now() + 101);
		expect(replayed).toHaveLength(1);
		await restarted.markStarted(id);
		await restarted.markCompleted(id);
		expect(existsSync(join(stateDir, `${id}.json`))).toBe(false);
	});

	it("marks a redelivered wake without changing its identity or stored text (spec 031, D3)", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			leaseMs: 100,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(event());
		expect(delivered[0]?.text).toBe("[EVENT:once] do work");
		expect(delivered[0]?.text).not.toContain("REDELIVERY");

		await service.drainOnce(Date.now() + 101);
		expect(delivered).toHaveLength(2);
		expect(delivered[1]?.text).toContain("[REDELIVERY:2]");
		expect(delivered[1]?.text).toContain("[EVENT:once] do work");
		// Identity and the persisted record must be untouched by the notice.
		expect(delivered[1]?.dispatchId).toBe(delivered[0]?.dispatchId);
		const stored = JSON.parse(readFileSync(join(stateDir, `${delivered[0]?.dispatchId}.json`), "utf-8"));
		expect(stored.event.text).toBe("[EVENT:once] do work");
	});

	it("renews the lease of a turn this process is still running (spec 031, D2)", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			leaseMs: 100,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(event());
		const id = delivered[0]?.dispatchId;
		await service.markStarted(id);

		// A turn far longer than the lease must not redeliver its own wake underneath itself.
		await service.drainOnce(Date.now() + 10_000);
		await service.drainOnce(Date.now() + 20_000);
		expect(delivered).toHaveLength(1);

		await service.markCompleted(id);
		expect(existsSync(join(stateDir, `${id}.json`))).toBe(false);
	});

	it("redelivers a running record once the process no longer holds it (spec 031, D2)", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			leaseMs: 100,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(event());
		await service.markStarted(delivered[0]?.dispatchId);

		// A restarted process holds no liveness claim, so the dead turn's record is replayed.
		const restarted = new DurableDispatchService({
			stateDir,
			leaseMs: 100,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await restarted.drainOnce(Date.now() + 101);
		expect(delivered).toHaveLength(2);
	});

	it("cancelChannel clears an in-flight lease so the next drain retries immediately", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			leaseMs: 15 * 60_000,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(event());
		expect(delivered).toHaveLength(1);

		// Simulate the record still being "in flight" (queued, long lease) when the
		// user hits /stop for that channel.
		const canceled = await service.cancelChannel("dm_1");
		expect(canceled).toBe(1);

		// Without cancelChannel this record would sit until the 15m lease expires;
		// after cancelling, the very next drain redelivers it.
		await service.drainOnce();
		expect(delivered).toHaveLength(2);

		expect(await service.cancelChannel("some-other-channel")).toBe(0);
	});

	it("cancelChannel drops the liveness claim of a running turn (spec 031, D2)", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			leaseMs: 15 * 60_000,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(event());
		await service.markStarted(delivered[0]?.dispatchId);

		expect(await service.cancelChannel("dm_1")).toBe(1);

		// Without dropping the claim, the renew branch would keep this record alive forever
		// and the stopped turn would never be redelivered.
		await service.drainOnce();
		expect(delivered).toHaveLength(2);
	});
});
