import { existsSync, readdirSync } from "node:fs";
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
});
