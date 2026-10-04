import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as log from "../src/log.js";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { type DurableDispatchRecord, DurableDispatchService } from "../src/runtime/durable-dispatch.js";
import { claimVerifiedDelegationWake } from "../src/runtime/task-wake.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { readStoredTask } from "../src/tasks/store.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "./helpers/background-runtime.js";
import { useTempDirs } from "./helpers/fixtures.js";

const tempDir = useTempDirs("pipiclaw-dispatch-");

afterEach(() => {
	vi.useRealTimers();
});

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
	it("logs and keeps draining when a record write fails instead of crashing the process", async () => {
		// The drain runs on an interval, so a write that throws (a full or read-only disk) has no
		// caller to reject to: unguarded, one ENOSPC window takes the whole daemon down.
		const stateDir = join(tempDir(), "state", "dispatch-readonly");
		let accept = false;
		const received: DingTalkEvent[] = [];
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

		const warnSpy = vi.spyOn(log, "logWarning").mockImplementation(() => undefined);
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
			expect(warnSpy).toHaveBeenCalledWith("Durable dispatch drain failed", expect.any(String));

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

	it("redelivers a structured task wake once despite the redelivery text prefix", async () => {
		const root = tempDir();
		const stateDir = join(root, "state", "dispatch");
		const workspaceDir = join(root, "workspace");
		const channelId = "dm_redelivery_task";
		const channelDir = join(workspaceDir, channelId);
		await mkdir(join(channelDir, "tasks", "archive"), { recursive: true });
		await writeFile(
			join(channelDir, "tasks", "T-redelivery.md"),
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
		const dispatchId = `subagent:${channelId}:run-redelivery:done`;
		const wake: DingTalkEvent = {
			...event(),
			channelId,
			text: "[SUBAGENT:run-redelivery] done. It belongs to task T-redelivery.",
			dispatchId,
			internalWake: { kind: "subagent", resourceId: "run-redelivery", taskId: "T-redelivery", dispatchId },
		};
		const delivered: DingTalkEvent[] = [];
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

		const claimed = await claimVerifiedDelegationWake(delivered[1]!, workspaceDir, manager);
		expect(claimed?.activated).toBe(true);
		await claimed?.finish();
		expect((await readStoredTask(channelDir, "T-redelivery"))?.fields.state).toBe("open");

		await service.drainOnce(Date.now() + 22);
		expect(delivered[2]?.text).toContain("[REDELIVERY:3]");
		// The task is already open, so a further claim on the same wake is a no-op — the run
		// manager's dispatchId-scoped wake claim is what makes this idempotent, not any per-task
		// attempt counter (that mechanism was retired).
		await expect(claimVerifiedDelegationWake(delivered[2]!, workspaceDir, manager)).resolves.toBeUndefined();
		expect((await readStoredTask(channelDir, "T-redelivery"))?.fields.state).toBe("open");
	});

	it("renews a running turn's lease — persisting only past the half-life — so it never redelivers itself (spec 031, D2)", async () => {
		vi.useFakeTimers();
		const start = new Date("2026-01-01T00:00:00.000Z");
		vi.setSystemTime(start);

		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
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

		// The same holds in-process after /stop: cancelChannel drops the liveness claim, so the
		// renew branch no longer keeps the stopped turn's record alive forever.
		await service.dispatch(event());
		await service.markStarted(delivered.at(-1)?.dispatchId);
		expect(await service.cancelChannel("dm_1")).toBe(1);

		await service.drainOnce();
		expect(delivered).toHaveLength(3);
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

	it("backs off a markRetryable failure instead of redelivering on the very next tick", async () => {
		vi.useFakeTimers();
		const start = new Date("2026-01-01T00:00:00.000Z");
		vi.setSystemTime(start);

		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
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
		const delivered: DingTalkEvent[] = [];
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
		// DingTalk group ids are base64 and routinely contain `/` (channel-paths.ts); a business id
		// derived from one used to become the filename verbatim, silently turning into a nested
		// path a flat readdir (what drainOnce/cancelChannel actually do) can never see again.
		const stateDir = join(tempDir(), "state", "dispatch");
		const delivered: DingTalkEvent[] = [];
		const dispatchId = "subagent:group_a/b=:run-1:done";
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

	it("migrates a pre-fix nested dispatch record so a new instance can drain it (R1)", async () => {
		// Simulates the actual pre-fix bug: an old process wrote a dispatch id containing `/`
		// verbatim as a path, which created a real subdirectory instead of a file.
		const stateDir = join(tempDir(), "state", "dispatch");
		const legacyId = "subagent:group_legacy/child:run-1:done";
		await mkdir(join(stateDir, "subagent:group_legacy"), { recursive: true });
		await writeFile(
			join(stateDir, "subagent:group_legacy", "child:run-1:done.json"),
			`${JSON.stringify({
				version: 1,
				id: legacyId,
				createdAt: new Date().toISOString(),
				status: "pending",
				deliveries: 0,
				event: { ...event(), channelId: "group_legacy", dispatchId: legacyId },
			})}\n`,
		);

		const delivered: DingTalkEvent[] = [];
		const service = new DurableDispatchService({
			stateDir,
			bot: {
				enqueueEvent(next) {
					delivered.push(next);
					return true;
				},
			},
		});
		await service.drainOnce();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.dispatchId).toBe(legacyId);
		// The legacy nested file is gone — migrated to its flat, encoded home.
		expect(existsSync(join(stateDir, "subagent:group_legacy", "child:run-1:done.json"))).toBe(false);
	});

	it("does not burn a delivery attempt on admission rejection, only on real failures (R2)", async () => {
		// A full ChannelQueue or a stopped bot rejects `enqueueEvent` immediately — the handler
		// never ran and never got a chance to fail. Counting that against MAX_DELIVERIES meant a
		// few minutes of congestion could permanently exhaust a record that was never actually
		// tried, discarding the message it carried for good.
		const stateDir = join(tempDir(), "state", "dispatch");
		let accept = false;
		const delivered: DingTalkEvent[] = [];
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
});
