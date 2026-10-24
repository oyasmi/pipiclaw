import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WakeEvent } from "../src/channel/channel-event.js";
import * as log from "../src/log.js";
import {
	type DurableDispatchRecord,
	DurableDispatchService,
	renderDispatchExhaustedNotice,
} from "../src/runtime/durable-dispatch.js";
import { createTaskDriverEvent } from "../src/runtime/task-driver.js";
import { claimVerifiedWake } from "../src/runtime/task-wake.js";
import * as atomicFile from "../src/shared/atomic-file.js";
import { renderTaskDocument } from "../src/tasks/contract.js";
import { readStoredTask } from "../src/tasks/store.js";
import { configureSubAgentRuntime, getSubAgentRunManager, testDesk } from "./helpers/background-runtime.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-dispatch-");

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function event(): WakeEvent {
	return {
		source: "wake",
		channelId: "dingtalk:dm:1",
		ts: "123",
		producer: "EVENT",
		text: "[EVENT:once] do work",
		desk: "news",
	};
}

describe("DurableDispatchService", () => {
	it("logs and keeps draining when a record write fails instead of crashing the process", async () => {
		// The drain runs on an interval, so a write that throws (a full or read-only disk) has no
		// caller to reject to: unguarded, one ENOSPC window takes the whole daemon down.
		const stateDir = join(tempDir(), "state", "dispatch-readonly");
		let accept = false;
		const received: WakeEvent[] = [];
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
		await service.dispatch(event());

		const warnSpy = vi.spyOn(log, "logWarn").mockImplementation(() => undefined);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown): void => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		try {
			chmodSync(stateDir, 0o555); // every atomic write into this directory now fails
			accept = true;
			service.start();
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(rejections).toEqual([]);
			expect(warnSpy).toHaveBeenCalledWith("dispatch.drain.failed", expect.any(String), expect.anything());

			// The record is untouched on disk, so recovery is just the next drain succeeding.
			chmodSync(stateDir, 0o755);
			await service.drainOnce();
			expect(received).toHaveLength(1);
		} finally {
			service.stop();
			chmodSync(stateDir, 0o755);
			process.off("unhandledRejection", onRejection);
			warnSpy.mockRestore();
		}
	});

	it("persists a queue-rejected dispatch and later delivers it, but refuses an event with no desk", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const received: WakeEvent[] = [];
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

		// Spec 058, D7: a producer that forgot its desk is refused before anything is persisted —
		// admission could never check such a wake against the channel's binding.
		const before = readdirSync(stateDir).length;
		await expect(service.dispatch({ ...event(), desk: undefined as unknown as string, ts: "456" })).resolves.toBe(
			false,
		);
		expect(readdirSync(stateDir)).toHaveLength(before);
		expect(received).toHaveLength(1);

		// Spec 061, INV-8: a record for a transport that is switched off waits on disk, untried and
		// uncounted, and goes out in a run where the transport is back.
		let reachable = false;
		const offService = new DurableDispatchService({
			stateDir,
			isReachable: () => reachable,
			bot: {
				enqueueEvent(next) {
					received.push(next);
					return true;
				},
			},
		});
		const waiting = { ...event(), ts: "789", text: "[EVENT:wait] later" };
		await expect(offService.dispatch(waiting)).resolves.toBe(false);
		await offService.drainOnce();
		expect(received).toHaveLength(1);
		const pending = readdirSync(stateDir)
			.map((name) => JSON.parse(readFileSync(join(stateDir, name), "utf-8")))
			.find((record) => record.event.text === waiting.text);
		expect(pending).toMatchObject({ status: "pending", deliveries: 0 });
		reachable = true;
		await offService.drainOnce();
		expect(received.map((next) => next.text)).toContain(waiting.text);
	});

	it("replays an expired lease after a restart and removes it only after completion", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const first: WakeEvent[] = [];
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

		const replayed: WakeEvent[] = [];
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
		const delivered: WakeEvent[] = [];
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

	it("redelivers a structured task wake once despite the redelivery text prefix", async () => {
		const root = tempDir();
		const stateDir = join(root, "state", "dispatch");
		const workspaceDir = join(root, "workspace");
		const channelId = "dingtalk:dm:redelivery_task";
		const deskDir = join(workspaceDir, channelId);
		await mkdir(join(deskDir, "tasks", "archive"), { recursive: true });
		await writeFile(
			join(deskDir, "tasks", "T-redelivery.md"),
			renderTaskDocument(
				{
					state: "parked",
					// Parked on the work whose wake is being redelivered (spec 052, D3).
					ticket: { kind: "work", refs: ["run-redelivery"], by: "2099-01-01T00:00:00+08:00" },
				},
				"# Redelivery\n",
			),
		);
		configureSubAgentRuntime({});
		const manager = getSubAgentRunManager(channelId);
		await manager.register({
			runId: "run-redelivery",
			channelId,
			runtime: "external",
			harness: "exec",
			agent: "runner",
			label: "redelivery",
			source: "inline",
			tools: [],
			purpose: "work",
			taskId: "T-redelivery",
			workingDirectory: workspaceDir,
			artifactDir: join(root, "artifacts"),
		});
		await manager.settle(
			"run-redelivery",
			{
				status: "completed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				usageKnown: false,
				costKnown: false,
				turns: 0,
				toolCalls: 0,
				durationMs: 1,
				outputText: "done",
			},
			{ announce: false },
		);
		const dispatchId = `subagent:${testDesk(channelId)}:run-redelivery:done`;
		const wake: WakeEvent = {
			...event(),
			channelId,
			text: "[SUBAGENT:run-redelivery] done. It belongs to task T-redelivery.",
			dispatchId,
			internalWake: { kind: "subagent", resourceId: "run-redelivery", taskId: "T-redelivery", dispatchId },
		};
		const delivered: WakeEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			leaseMs: 10,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(wake); // delivery #1 crashes before activation
		await service.drainOnce(Date.now() + 11);
		expect(delivered[1]?.text).toContain("[REDELIVERY:2]");

		const claimed = await claimVerifiedWake(delivered[1]!, deskDir, manager);
		expect(claimed?.activated).toBe(true);
		await claimed?.finish();
		expect((await readStoredTask(deskDir, "T-redelivery"))?.fields.state).toBe("open");

		await service.drainOnce(Date.now() + 22);
		expect(delivered[2]?.text).toContain("[REDELIVERY:3]");
		// The task is already open, so a further claim on the same wake is a no-op — the run
		// manager's dispatchId-scoped wake claim is what makes this idempotent, not any per-task
		// attempt counter (that mechanism was retired).
		await expect(claimVerifiedWake(delivered[2]!, workspaceDir, manager)).resolves.toBeUndefined();
		expect((await readStoredTask(deskDir, "T-redelivery"))?.fields.state).toBe("open");
	});

	it("renews a running turn's lease — persisting only past the half-life — so it never redelivers itself (spec 031, D2)", async () => {
		vi.useFakeTimers();
		const start = new Date("2026-01-01T00:00:00.000Z");
		vi.setSystemTime(start);

		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: WakeEvent[] = [];
		const leaseMs = 100_000;
		const service = new DurableDispatchService({
			stateDir,
			leaseMs,
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
		const path = join(stateDir, `${id}.json`);
		const leaseAfterStart = JSON.parse(readFileSync(path, "utf-8")).leaseExpiresAt;

		// Well before the half-life (50s into a 100s lease): drain must not touch the file.
		vi.setSystemTime(new Date(start.getTime() + 10_000));
		await service.drainOnce(Date.now());
		expect(JSON.parse(readFileSync(path, "utf-8")).leaseExpiresAt).toBe(leaseAfterStart);

		// Past the half-life: drain renews and persists the new expiry.
		vi.setSystemTime(new Date(start.getTime() + 60_000));
		await service.drainOnce(Date.now());
		const leaseAfterRenewal = JSON.parse(readFileSync(path, "utf-8")).leaseExpiresAt;
		expect(leaseAfterRenewal).not.toBe(leaseAfterStart);

		// A turn far longer than its lease must not redeliver its own wake underneath itself.
		vi.setSystemTime(new Date(start.getTime() + 200_000));
		await service.drainOnce(Date.now());
		vi.setSystemTime(new Date(start.getTime() + 300_000));
		await service.drainOnce(Date.now());
		expect(delivered).toHaveLength(1);

		await service.markCompleted(id);
		expect(existsSync(path)).toBe(false);
	});

	it("redelivers a started record once this process no longer holds its liveness claim (spec 031, D2)", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: WakeEvent[] = [];
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

		// The same holds in-process after /stop: cancelChannel drops the liveness claim, so the
		// renew branch no longer keeps the stopped turn's record alive forever.
		await service.dispatch(event());
		await service.markStarted(delivered.at(-1)?.dispatchId);
		expect(await service.cancelChannel("dingtalk:dm:1")).toBe(1);

		await service.drainOnce();
		expect(delivered).toHaveLength(3);
	});

	it("cancelChannel clears an in-flight lease so the next drain retries immediately", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: WakeEvent[] = [];
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
		const canceled = await service.cancelChannel("dingtalk:dm:1");
		expect(canceled).toBe(1);

		// Without cancelChannel this record would sit until the 15m lease expires;
		// after cancelling, the very next drain redelivers it.
		await service.drainOnce();
		expect(delivered).toHaveLength(2);

		expect(await service.cancelChannel("some-other-channel")).toBe(0);
	});

	it("backs off a markRetryable failure instead of redelivering on the very next tick", async () => {
		vi.useFakeTimers();
		const start = new Date("2026-01-01T00:00:00.000Z");
		vi.setSystemTime(start);

		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: WakeEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(event());
		expect(delivered).toHaveLength(1);
		const id = delivered[0]?.dispatchId;

		// The handler claimed the turn, then failed structurally (not a queue race) — markRetryable
		// must not make it eligible for redelivery on the very next 30s drain tick.
		await service.markStarted(id);
		await service.markRetryable(id);

		vi.setSystemTime(new Date(start.getTime() + 5_000));
		await service.drainOnce(Date.now());
		expect(delivered).toHaveLength(1);

		vi.setSystemTime(new Date(start.getTime() + 31_000));
		await service.drainOnce(Date.now());
		expect(delivered).toHaveLength(2);
	});

	it("gives up after repeated markRetryable failures and notifies onExhausted exactly once", async () => {
		vi.useFakeTimers();
		let now = new Date("2026-01-01T00:00:00.000Z");
		vi.setSystemTime(now);

		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: WakeEvent[] = [];
		const exhausted: DurableDispatchRecord[] = [];
		const service = new DurableDispatchService({
			stateDir,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
			onExhausted: (record) => {
				exhausted.push(record);
			},
		});
		await service.dispatch(event());
		const id = delivered[0]?.dispatchId;

		// A structural failure (disk full, permissions) that repeats on every delivery must
		// eventually stop retrying instead of looping every 30s forever.
		for (let i = 0; i < 12 && exhausted.length === 0; i++) {
			await service.markStarted(id);
			await service.markRetryable(id);
			now = new Date(now.getTime() + 20 * 60_000); // well past the capped backoff
			vi.setSystemTime(now);
			await service.drainOnce(Date.now());
		}

		expect(exhausted).toHaveLength(1);
		expect(exhausted[0]?.id).toBe(id);
		const deliveredCount = delivered.length;
		expect(deliveredCount).toBeGreaterThan(1);
		expect(deliveredCount).toBeLessThan(12);

		const stored = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf-8"));
		expect(stored.status).toBe("exhausted");

		// The poison-pilled record is neither redelivered nor re-notified.
		now = new Date(now.getTime() + 20 * 60_000);
		vi.setSystemTime(now);
		await service.drainOnce(Date.now());
		expect(delivered).toHaveLength(deliveredCount);
		expect(exhausted).toHaveLength(1);
	});

	it("keeps a dispatch id containing a channel-id slash on one flat file, so a fresh instance can still find it (R1)", async () => {
		// DingTalk group ids are base64 and routinely contain `/` (channel/channel-id.ts); a business id
		// derived from one used to become the filename verbatim, silently turning into a nested
		// path a flat readdir (what drainOnce/cancelChannel actually do) can never see again.
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: WakeEvent[] = [];
		const dispatchId = "subagent:dingtalk:group:a/b=:run-1:done";
		const service = new DurableDispatchService({
			stateDir,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch({ ...event(), dispatchId });
		expect(delivered).toHaveLength(1);

		const entries = readdirSync(stateDir, { withFileTypes: true });
		expect(entries).toHaveLength(1);
		expect(entries[0]?.isFile()).toBe(true);

		// A "restart" is just a new instance over the same directory; it must still see the record.
		const restarted = new DurableDispatchService({ stateDir, bot: { enqueueEvent: () => true } });
		expect(await restarted.cancelChannel(event().channelId)).toBe(1);
	});

	it("does not burn a delivery attempt on admission rejection, only on real failures (R2)", async () => {
		// A full ChannelQueue or a stopped bot rejects `enqueueEvent` immediately — the handler
		// never ran and never got a chance to fail. Counting that against MAX_DELIVERIES meant a
		// few minutes of congestion could permanently exhaust a record that was never actually
		// tried, discarding the message it carried for good.
		const stateDir = join(tempDir(), "state", "dispatch");
		let accept = false;
		const delivered: WakeEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			bot: {
				enqueueEvent(next) {
					if (!accept) return false;
					delivered.push(next);
					return true;
				},
			},
		});
		await service.dispatch(event());
		const id = readdirSync(stateDir)[0]?.replace(/\.json$/, "");
		expect(id).toBeTruthy();

		// Far past MAX_DELIVERIES (8) worth of congestion — none of it a real delivery attempt.
		for (let i = 0; i < 20; i++) {
			await service.drainOnce();
		}
		const stored = JSON.parse(readFileSync(join(stateDir, `${id}.json`), "utf-8"));
		expect(stored.status).toBe("pending");
		expect(stored.deliveries).toBe(0);

		// Capacity returns: the record is still eligible, not exhausted.
		accept = true;
		await service.drainOnce();
		expect(delivered).toHaveLength(1);
	});

	// Spec 053 F1.1: the exhausted-wake notice used to forward `event.text` and `event.user` — for a
	// task step that is the model's English prompt and the `TASK_DRIVER` tag, sent to the user.
	it("names the wake's task in the exhausted notice without forwarding the prompt or producer tag", () => {
		const wake = createTaskDriverEvent(
			"news",
			"dingtalk:group:cid+a/b==",
			{
				id: "weekly-report",
				title: "周报",
				fields: { state: "open" },
				readable: true,
				runnable: true,
				expired: false,
			},
			Date.now(),
		);
		const record: DurableDispatchRecord = {
			version: 1,
			id: wake.dispatchId as string,
			createdAt: new Date().toISOString(),
			status: "exhausted",
			event: wake,
			deliveries: 8,
		};
		const stateDir = join(tempDir(), "state", "dispatch");
		const notice = renderDispatchExhaustedNotice(record, stateDir);

		expect(notice).not.toContain("TASK_DRIVER");
		expect(notice).not.toContain("Resume task");
		expect(notice).toContain("/tasks show weekly-report");
		// An absolute path to the kept record, not a path relative to an unnamed directory.
		expect(notice).toContain(stateDir);
	});
});

describe("DurableDispatchService.absorbPending (completion-wake coalescing)", () => {
	function wake(channelId: string, runId: string, text = `[SUBAGENT:${runId}] finished`): WakeEvent {
		return {
			source: "wake",
			channelId,
			ts: String(Date.now()),
			producer: "SUBAGENT",
			text,
			dispatchId: `subagent:${channelId}:${runId}:done`,
			desk: "news",
		};
	}

	function capturingService(stateDir: string, accept: () => boolean = () => true) {
		const delivered: WakeEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			bot: {
				enqueueEvent(next) {
					if (!accept()) return false;
					delivered.push(next);
					return true;
				},
			},
		});
		return { service, delivered };
	}

	const isWake = (candidate: WakeEvent) => candidate.producer === "SUBAGENT";

	it.each([true, false])(
		"preserves earlier claims and leaves a failed claim deliverable (queued=%s)",
		async (queued) => {
			const stateDir = join(tempDir(), "state", "dispatch");
			let accept = true;
			const { service, delivered } = capturingService(stateDir, () => accept);
			await service.dispatch(wake("dingtalk:dm:1", "run_a"));
			accept = queued;
			for (const [index, runId] of ["run_b", "run_c"].entries()) {
				await service.dispatch(wake("dingtalk:dm:1", runId));
				const path = join(stateDir, `${encodeURIComponent(`subagent:dingtalk:dm:1:${runId}:done`)}.json`);
				const record = JSON.parse(readFileSync(path, "utf-8"));
				record.createdAt = new Date(index).toISOString();
				await writeFile(path, JSON.stringify(record));
			}
			const failedId = "subagent:dingtalk:dm:1:run_c:done";
			const write = atomicFile.writeFileAtomically;
			const fault = vi
				.spyOn(atomicFile, "writeFileAtomically")
				.mockImplementation(async (path, content, options) => {
					if (
						path.endsWith(`${encodeURIComponent(failedId)}.json`) &&
						JSON.parse(String(content)).status === "running"
					) {
						throw new Error("injected ENOSPC");
					}
					await write(path, content, options);
				});
			await service.markStarted(delivered[0]?.dispatchId);
			const claimed = await service.absorbPending("dingtalk:dm:1", delivered[0]!.dispatchId!, isWake, 5);
			expect(claimed.map((item) => item.dispatchId)).toEqual(["subagent:dingtalk:dm:1:run_b:done"]);
			const failed = JSON.parse(readFileSync(join(stateDir, `${encodeURIComponent(failedId)}.json`), "utf-8"));
			expect(failed.status).toBe(queued ? "queued" : "pending");
			expect(failed.deliveries).toBe(queued ? 1 : 0);
			fault.mockRestore();
			for (const item of claimed) await service.markCompleted(item.dispatchId);
			await service.markCompleted(delivered[0]?.dispatchId);
			accept = true;
			await service.drainOnce(Date.now() + 20 * 60_000);
			expect(delivered.at(-1)?.dispatchId).toBe(failedId);
			expect(await service.markStarted(failedId)).toBe(true);
		},
	);

	it("folds this channel's waiting wakes into the starting turn and turns their stale deliveries away", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const { service, delivered } = capturingService(stateDir);
		await service.dispatch(wake("dingtalk:dm:1", "run_a"));
		await service.dispatch(wake("dingtalk:dm:1", "run_b"));
		await service.dispatch(wake("dingtalk:dm:2", "run_other"));
		await service.dispatch({ ...event(), dispatchId: "event:dingtalk:dm:1:x" });
		const primary = delivered[0]?.dispatchId as string;

		expect(await service.markStarted(primary)).toBe(true);
		const absorbed = await service.absorbPending("dingtalk:dm:1", primary, isWake, 5);

		// Only the same channel's matching wakes; never the primary, another channel, or an event.
		expect(absorbed.map((item) => item.dispatchId)).toEqual(["subagent:dingtalk:dm:1:run_b:done"]);
		// run_b's own queued delivery comes through later and must not run it a second time.
		expect(await service.markStarted("subagent:dingtalk:dm:1:run_b:done")).toBe(false);
		await service.markCompleted(primary);
		await service.markCompleted("subagent:dingtalk:dm:1:run_b:done");
		const remaining = readdirSync(stateDir).map((name) => decodeURIComponent(name));
		expect(remaining).toEqual(
			expect.arrayContaining(["subagent:dingtalk:dm:2:run_other:done.json", "event:dingtalk:dm:1:x.json"]),
		);
		expect(remaining).toHaveLength(2);
	});

	it("claims a never-delivered wake too, and the drain does not deliver it underneath the turn", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		let accept = true;
		const { service, delivered } = capturingService(stateDir, () => accept);
		await service.dispatch(wake("dingtalk:dm:1", "run_a"));
		accept = false; // channel queue full: run_b stays pending on disk
		await service.dispatch(wake("dingtalk:dm:1", "run_b"));
		accept = true;
		const primary = delivered[0]?.dispatchId as string;
		await service.markStarted(primary);

		const absorbed = await service.absorbPending("dingtalk:dm:1", primary, isWake, 5);
		expect(absorbed).toHaveLength(1);
		await service.drainOnce();
		expect(delivered).toHaveLength(1);
	});

	it("lets /stop redeliver absorbed wakes on their own", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const { service, delivered } = capturingService(stateDir);
		await service.dispatch(wake("dingtalk:dm:1", "run_a"));
		await service.dispatch(wake("dingtalk:dm:1", "run_b"));
		const primary = delivered[0]?.dispatchId as string;
		await service.markStarted(primary);
		await service.absorbPending("dingtalk:dm:1", primary, isWake, 5);

		// /stop dropped the queued closures and reset the channel's in-flight records.
		await service.cancelChannel("dingtalk:dm:1");
		await service.drainOnce();
		const redelivered = delivered.slice(2).map((item) => item.dispatchId);
		expect(redelivered).toEqual(expect.arrayContaining([primary, "subagent:dingtalk:dm:1:run_b:done"]));
		// The redelivery of the formerly absorbed wake is a real delivery now, not a stale one.
		expect(await service.markStarted("subagent:dingtalk:dm:1:run_b:done")).toBe(true);
	});

	it("respects the limit, oldest first", async () => {
		const stateDir = join(tempDir(), "state", "dispatch");
		const { service, delivered } = capturingService(stateDir);
		for (const runId of ["run_a", "run_b", "run_c", "run_d"]) {
			await service.dispatch(wake("dingtalk:dm:1", runId));
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		const primary = delivered[0]?.dispatchId as string;
		await service.markStarted(primary);
		const absorbed = await service.absorbPending("dingtalk:dm:1", primary, isWake, 2);
		expect(absorbed.map((item) => item.dispatchId)).toEqual([
			"subagent:dingtalk:dm:1:run_b:done",
			"subagent:dingtalk:dm:1:run_c:done",
		]);
	});
});
