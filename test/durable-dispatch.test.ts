import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { DurableDispatchService } from "../src/runtime/durable-dispatch.js";
import { claimVerifiedDelegationWake } from "../src/runtime/task-wake.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { readStoredTask } from "../src/tasks/store.js";
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
					status: "waiting",
					control: { ...createDefaultTaskControl(), waitingFor: "external-signal" },
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

		const claimed = await claimVerifiedDelegationWake(delivered[1]!, workspaceDir);
		expect(claimed?.activated).toBe(true);
		await claimed?.finish();
		expect((await readStoredTask(channelDir, "T-redelivery"))?.fields.status).toBe("active");

		await service.drainOnce(Date.now() + 22);
		expect(delivered[2]?.text).toContain("[REDELIVERY:3]");
		// The task is already active, so a further claim on the same wake is a no-op — the run
		// manager's dispatchId-scoped wake claim is what makes this idempotent, not any per-task
		// attempt counter (that mechanism was retired).
		await expect(claimVerifiedDelegationWake(delivered[2]!, workspaceDir)).resolves.toBeUndefined();
		expect((await readStoredTask(channelDir, "T-redelivery"))?.fields.status).toBe("active");
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

	it("only persists a running lease renewal once past the half-life threshold", async () => {
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

		await service.markCompleted(id);
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
