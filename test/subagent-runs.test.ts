import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LoggedSubAgentRun } from "../src/channel/store.js";
import type { DingTalkEvent } from "../src/dingtalk/handler.js";
import type { SettleInput } from "../src/subagents/run-record.js";
import { MAX_RUNNING_SUBAGENT_RUNS_PER_HOST } from "../src/subagents/run-record.js";
import { createSubAgentRuntime } from "../src/subagents/run-registry.js";
import { SubAgentRunManager } from "../src/subagents/runs.js";
import { acquireWorkspaceLease, releaseWorkspaceLease } from "../src/subagents/workspace-lease.js";
import { createUsage } from "../src/tasks/budget.js";
import { renderTaskDocument } from "../src/tasks/contract.js";
import { resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import { parkTask, readStoredTask } from "../src/tasks/store.js";
import type { UsageLedgerEntry } from "../src/usage/ledger.js";
import {
	configureSubAgentRuntime,
	getSubAgentRunManager,
	restoreAllSubAgentRuns,
} from "./helpers/background-runtime.js";
import { useTempDirs } from "./helpers/fixtures.js";

/** One dot owns these runs; each record keeps its own originating channel (spec 058, D15). */
const DOT = { dot: "news", dotDir: join(tmpdir(), "pipiclaw-subagent-runs-dot") };

const createTempDir = useTempDirs("pipiclaw-subagent-runs-");

function emptyUsage() {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		total: 15,
		cost: { input: 0.1, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.15 },
	};
}

function baseSettleInput(overrides: Partial<SettleInput> = {}): SettleInput {
	return {
		status: "completed",
		usage: emptyUsage(),
		usageKnown: true,
		costKnown: true,
		turns: 1,
		toolCalls: 0,
		durationMs: 500,
		outputText: "The answer is 42.",
		...overrides,
	};
}

function makeLedger() {
	const records: Array<Omit<UsageLedgerEntry, "ts">> = [];
	return {
		records,
		ledger: {
			record: (entry: Omit<UsageLedgerEntry, "ts">) => {
				records.push(entry);
			},
			summarize: async () => ({
				totalCost: 0,
				totalTokens: 0,
				entryCount: 0,
				byKind: {},
				byModel: {},
				byChannel: {},
				byTask: {},
				unknownUsageCount: 0,
				unknownCostCount: 0,
			}),
		},
	};
}

function makeStore() {
	const archived: Array<{ channelId: string; run: LoggedSubAgentRun }> = [];
	return {
		archived,
		store: {
			logSubAgentRun: async (channelId: string, run: LoggedSubAgentRun) => {
				archived.push({ channelId, run });
			},
		} as unknown as import("../src/channel/store.js").ChannelStore,
	};
}

function makeDispatch() {
	const events: DingTalkEvent[] = [];
	return {
		events,
		dispatch: (event: DingTalkEvent) => {
			events.push(event);
			return true;
		},
	};
}

function register(manager: SubAgentRunManager, overrides: Partial<Parameters<SubAgentRunManager["register"]>[0]> = {}) {
	return manager.register({
		runId: "run-1",
		channelId: "dm_123",
		runtime: "internal",
		agent: "explorer",
		label: "explore the repo",
		source: "predefined",
		tools: ["read"],
		model: "anthropic/claude-x",
		purpose: "work",
		workingDirectory: "/tmp",
		artifactDir: "/tmp/artifacts/run-1",
		...overrides,
	});
}

describe("SubAgentRunManager (spec 040, D1/D7)", () => {
	it("keeps identical channel/run ids isolated between application instances and their wake sinks", async () => {
		const firstWake = makeDispatch();
		const secondWake = makeDispatch();
		const first = createSubAgentRuntime({ workspaceDir: DOT.dotDir, dispatch: firstWake.dispatch });
		const second = createSubAgentRuntime({ workspaceDir: DOT.dotDir, dispatch: secondWake.dispatch });
		try {
			await register(first.get("news"), { artifactDir: createTempDir() });
			await register(second.get("news"), { artifactDir: createTempDir() });
			await first.get("news").settle("run-1", baseSettleInput(), { announce: true });
			expect(first.get("news").get("run-1")?.status).toBe("completed");
			expect(second.get("news").get("run-1")?.status).toBe("running");
			expect(firstWake.events).toHaveLength(1);
			expect(secondWake.events).toHaveLength(0);
		} finally {
			first.stop();
			second.stop();
		}
	});

	it("admits at most one cross-channel registration at the host cap boundary", async () => {
		configureSubAgentRuntime({});
		const prefix = `host-cap-${Date.now()}`;
		for (let index = 0; index < MAX_RUNNING_SUBAGENT_RUNS_PER_HOST - 1; index++) {
			const channelId = `${prefix}-${index}`;
			await register(getSubAgentRunManager(channelId), { runId: `run-${index}`, channelId });
		}

		const firstChannel = `${prefix}-first`;
		const secondChannel = `${prefix}-second`;
		const results = await Promise.allSettled([
			register(getSubAgentRunManager(firstChannel), { runId: "edge-first", channelId: firstChannel }),
			register(getSubAgentRunManager(secondChannel), { runId: "edge-second", channelId: secondChannel }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({
			reason: expect.objectContaining({ message: expect.stringContaining("host-wide") }),
		});
		const total = Array.from({ length: MAX_RUNNING_SUBAGENT_RUNS_PER_HOST - 1 }, (_, index) =>
			getSubAgentRunManager(`${prefix}-${index}`).runningCount(),
		).reduce((sum, count) => sum + count, 0);
		expect(
			total +
				getSubAgentRunManager(firstChannel).runningCount() +
				getSubAgentRunManager(secondChannel).runningCount(),
		).toBe(MAX_RUNNING_SUBAGENT_RUNS_PER_HOST);

		await Promise.all([
			...Array.from({ length: MAX_RUNNING_SUBAGENT_RUNS_PER_HOST - 1 }, (_, index) =>
				getSubAgentRunManager(`${prefix}-${index}`).cancel(`run-${index}`),
			),
			getSubAgentRunManager(firstChannel).cancel("edge-first"),
			getSubAgentRunManager(secondChannel).cancel("edge-second"),
		]);
	});

	it("settling inline (announce:false) records usage/archive once and marks wakeEnqueued without dispatching", async () => {
		const { ledger, records } = makeLedger();
		const { store, archived } = makeStore();
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager(DOT, { ledger, store, dispatch });
		await register(manager);

		await manager.settle("run-1", baseSettleInput(), { announce: false });

		expect(events).toHaveLength(0);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ kind: "subagent", runId: "run-1", channelId: "dm_123" });
		expect(archived).toHaveLength(1);
		expect(archived[0]?.run).toMatchObject({ runId: "run-1", status: "completed", taskId: undefined });
		expect(manager.get("run-1")?.wakeEnqueued).toBe(true);
		expect(manager.get("run-1")?.settledAt).toBeDefined();
	});

	it("settling with announce:true dispatches exactly one completion wake naming the run and task", async () => {
		const { ledger } = makeLedger();
		const { store } = makeStore();
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager(DOT, { ledger, store, dispatch });
		await register(manager, { taskId: "T-7" });

		await manager.settle("run-1", baseSettleInput({ outputText: "Found the bug in src/index.ts." }), {
			announce: true,
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.dispatchId).toBe("subagent:news:run-1:done");
		expect(events[0]?.internalWake).toEqual({
			kind: "subagent",
			resourceId: "run-1",
			taskId: "T-7",
			dispatchId: "subagent:news:run-1:done",
		});
		expect(events[0]?.text).toContain("[SUBAGENT:run-1]");
		expect(events[0]?.text).toContain("It belongs to task T-7.");
		expect(events[0]?.text).toContain("Found the bug in src/index.ts.");
		expect(events[0]?.text).toContain("[SILENT]");
		// P0-2: an "awaited" wake renders the resulting turn's progress instead of the "none" style
		// autonomous check-ins get.
		expect(events[0]?.presentation).toBe("awaited");
	});

	it("drops the wake for a channel rebound to another dot, but still redeems its task's work ticket", async () => {
		// Spec 058, D8. Failure caught: a dropped wake leaving the task parked on `work` with nothing
		// left to redeem it — on rebind the task would sit until its backstop expired.
		const dotDir = createTempDir();
		mkdirSync(join(dotDir, "tasks"), { recursive: true });
		writeFileSync(
			join(dotDir, "tasks", "T-8.md"),
			renderTaskDocument({ state: "open", usage: createUsage() }, "# T\n"),
		);
		await parkTask(dotDir, "T-8", { kind: "work", refs: ["run-1"], by: "2099-01-01T00:00:00+08:00" });
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager({ dot: "news", dotDir }, { dispatch, isBoundTo: () => false });
		await register(manager, { taskId: "T-8" });

		await manager.settle("run-1", baseSettleInput(), { announce: true });

		expect(events).toHaveLength(0);
		expect(manager.get("run-1")?.wakeEnqueued).toBe(true);
		expect((await readStoredTask(dotDir, "T-8"))?.fields.state).toBe("open");
		await resetTaskLogAppenders();
	});

	it("emits a settled notice (P0-1) whenever announce:true would dispatch a wake, and none otherwise", async () => {
		const { ledger } = makeLedger();
		const { store } = makeStore();
		const { dispatch } = makeDispatch();
		const notices: Array<{ channelId: string; notice: unknown }> = [];
		const manager = new SubAgentRunManager(DOT, {
			ledger,
			store,
			dispatch,
			notify: (_dot, channelId, notice) => {
				notices.push({ channelId, notice });
			},
		});
		await register(manager, { runId: "run-announced" });
		await manager.settle("run-announced", baseSettleInput(), { announce: true });

		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({
			channelId: "dm_123",
			notice: { kind: "settled", runId: "run-announced", agent: "explorer", status: "completed" },
		});

		await register(manager, { runId: "run-inline" });
		await manager.settle("run-inline", baseSettleInput(), { announce: false });
		expect(notices).toHaveLength(1); // Inline (already-held-by-the-model) results stay silent.
	});

	// K chat-level fan-out runs each wake the channel; without the count the model cannot tell which
	// wake is the last one and re-checks with subagent_list every time.
	it("tells a chat-level wake how many sibling runs on the channel are still running", async () => {
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager(DOT, { dispatch });
		await register(manager, { runId: "run-a" });
		await register(manager, { runId: "run-b" });
		await register(manager, { runId: "run-task", taskId: "T-1" });
		// Another channel of the same dot: its wake goes there, so it is no sibling of this one's
		// (counting it would leave this channel waiting, [SILENT], for a wake it never gets).
		await register(manager, { runId: "run-elsewhere", channelId: "group_cidOTHER" });

		await manager.settle("run-a", baseSettleInput(), { announce: true });
		await manager.settle("run-b", baseSettleInput(), { announce: true });

		// Neither a task's run nor another channel's is a chat-level sibling.
		expect(events[0]?.text).toContain("1 other run(s) on this channel are still running.");
		expect(events[1]?.text).not.toContain("other run(s)");
	});

	it("paces an async internal run's step notices like the external tail, and stops at settlement", async () => {
		vi.useFakeTimers();
		try {
			const notices: Array<{ kind: string; step?: string }> = [];
			const manager = new SubAgentRunManager(DOT, {
				notify: (_dot, _channelId, notice) => {
					notices.push(notice);
				},
			});
			await register(manager, { runId: "run-async" });
			const flush = () => vi.advanceTimersByTimeAsync(0);

			manager.noteProgress("run-async", "读取 src/a.ts");
			await flush();
			expect(notices).toEqual([]); // inside the first-notice delay

			vi.advanceTimersByTime(60_000);
			manager.noteProgress("run-async", "读取 src/b.ts");
			await flush();
			expect(notices).toEqual([expect.objectContaining({ kind: "progress", step: "读取 src/b.ts" })]);

			manager.noteProgress("run-async", "执行 npm test");
			await flush();
			expect(notices).toHaveLength(1); // inside the minimum gap

			await manager.settle("run-async", baseSettleInput(), { announce: false });
			vi.advanceTimersByTime(600_000);
			manager.noteProgress("run-async", "执行 npm run build");
			await flush();
			expect(notices).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let a throwing notifier affect settlement", async () => {
		const { ledger, records } = makeLedger();
		const { store, archived } = makeStore();
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager(DOT, {
			ledger,
			store,
			dispatch,
			notify: () => {
				throw new Error("notifier is down");
			},
		});
		await register(manager);

		await manager.settle("run-1", baseSettleInput(), { announce: true });

		expect(events).toHaveLength(1);
		expect(records).toHaveLength(1);
		expect(archived).toHaveLength(1);
		expect(manager.get("run-1")?.settledAt).toBeDefined();
	});

	it("settle is idempotent: a second call for the same run neither re-bills nor re-announces", async () => {
		const { ledger, records } = makeLedger();
		const { store, archived } = makeStore();
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager(DOT, { ledger, store, dispatch });
		await register(manager);

		const input = baseSettleInput();
		await manager.settle("run-1", input, { announce: true });
		await manager.settle("run-1", input, { announce: true });
		await manager.settle("run-1", input, { announce: false });

		expect(events).toHaveLength(1);
		expect(records).toHaveLength(1);
		expect(archived).toHaveLength(1);
	});

	it("refuses a wake claim that does not match the run's own record", async () => {
		const manager = new SubAgentRunManager(DOT, {});
		await register(manager, { taskId: "T-1" });
		const dispatchId = "subagent:news:run-1:done";
		// Not settled yet: it cannot have produced a completion wake.
		await expect(manager.beginWakeConsumption("run-1", "T-1", dispatchId)).resolves.toBe(false);
		await manager.settle("run-1", baseSettleInput(), { announce: false });
		await expect(manager.beginWakeConsumption("run-missing", "T-1", dispatchId)).resolves.toBe(false);
		await expect(manager.beginWakeConsumption("run-1", "T-other", dispatchId)).resolves.toBe(false);
		await expect(manager.beginWakeConsumption("run-1", "T-1", `${dispatchId}:replay`)).resolves.toBe(false);
		await expect(manager.beginWakeConsumption("run-1", "T-1", dispatchId)).resolves.toBe(true);
		// The exact wake is consumed once: after it finishes, a replay of it is refused.
		await manager.finishWakeConsumption("run-1", dispatchId);
		await expect(manager.beginWakeConsumption("run-1", "T-1", dispatchId)).resolves.toBe(false);
	});

	it("cancel invokes the registered handle and does not itself dispatch a wake", async () => {
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager(DOT, { dispatch });
		await register(manager);
		let cancelled = false;
		manager.registerCancelHandle("run-1", () => {
			cancelled = true;
		});

		const status = await manager.cancel("run-1");

		expect(cancelled).toBe(true);
		expect(status).toBe("running"); // the caller's own settle() (triggered by its abort) drives the terminal status
		expect(events).toHaveLength(0);
		// A worker may observe abort asynchronously. Until settle() owns cleanup, a repeated cancel
		// must not turn the still-active run into a lost writer and release its workspace lease.
		await expect(manager.cancel("run-1")).resolves.toBe("running");
	});

	it("cancel with no live handle marks the run lost without dispatching", async () => {
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager(DOT, { dispatch });
		await register(manager);

		const status = await manager.cancel("run-1");

		expect(status).toBe("lost");
		expect(events).toHaveLength(0);
		expect(manager.get("run-1")?.status).toBe("lost");
	});

	it("restore settles a still-running internal run as lost and wakes the channel exactly once", async () => {
		const stateDir = createTempDir();
		mkdirSync(join(stateDir, "news"), { recursive: true });
		const { ledger } = makeLedger();
		const { store } = makeStore();
		const { dispatch, events } = makeDispatch();

		const writer = new SubAgentRunManager(DOT, { stateDir });
		await writer.register({
			runId: "run-orphan",
			channelId: "dm_123",
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-orphan",
		});

		// A fresh manager, as if the daemon just restarted: only the persisted record exists.
		const restored = new SubAgentRunManager(DOT, { stateDir, ledger, store, dispatch });
		const count = await restored.restore();

		expect(count).toBe(1);
		expect(restored.get("run-orphan")?.status).toBe("lost");
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain("[SUBAGENT:run-orphan]");
		expect(events[0]?.text).toContain("lost");

		const persisted = JSON.parse(readFileSync(join(stateDir, "news", "run-orphan.json"), "utf-8"));
		expect(persisted.status).toBe("lost");
		expect(persisted.wakeEnqueued).toBe(true);
	});

	it("restore leaves an already-terminal record alone", async () => {
		const stateDir = createTempDir();
		mkdirSync(join(stateDir, "news"), { recursive: true });
		const { dispatch, events } = makeDispatch();

		const writer = new SubAgentRunManager(DOT, { stateDir });
		await writer.register({
			runId: "run-done",
			channelId: "dm_123",
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-done",
		});
		await writer.settle("run-done", baseSettleInput(), { announce: false });

		const restored = new SubAgentRunManager(DOT, { stateDir, dispatch });
		await restored.restore();

		expect(events).toHaveLength(0);
		expect(restored.get("run-done")?.status).toBe("completed");
	});

	// R7b: a record that is only temporarily unreadable (a permissions slip, a filesystem hiccup)
	// must not be treated as the same failure as one that is genuinely corrupt. The old code
	// unlinked either way, permanently destroying the only trace of an external run's completion
	// over a transient I/O error that a later restart could otherwise have retried past.
	it.skipIf(process.getuid?.() === 0)(
		"restore skips (and keeps) a run record that is unreadable rather than corrupt",
		async () => {
			const stateDir = createTempDir();
			mkdirSync(join(stateDir, "news"), { recursive: true });
			const writer = new SubAgentRunManager(DOT, { stateDir });
			await writer.register({
				runId: "run-locked",
				channelId: "dm_123",
				runtime: "internal",
				agent: "explorer",
				label: "explore",
				source: "predefined",
				tools: [],
				purpose: "work",
				workingDirectory: "/tmp",
				artifactDir: "/tmp/artifacts/run-locked",
			});
			const path = join(stateDir, "news", "run-locked.json");
			chmodSync(path, 0o000);
			try {
				const { dispatch, events } = makeDispatch();
				const restored = new SubAgentRunManager(DOT, { stateDir, dispatch });
				expect(await restored.restore()).toBe(0);
				expect(events).toHaveLength(0);
				expect(restored.get("run-locked")).toBeUndefined();
				// Left on disk, unlike the old unconditional unlink — a later restart, once
				// permissions are fixed, can still recover it.
				expect(existsSync(path)).toBe(true);
			} finally {
				chmodSync(path, 0o600);
			}
		},
	);

	it("restore quarantines (never deletes) a genuinely corrupt run record", async () => {
		const stateDir = createTempDir();
		mkdirSync(join(stateDir, "news"), { recursive: true });
		const path = join(stateDir, "news", "run-corrupt.json");
		writeFileSync(path, "{not valid json");

		const { dispatch, events } = makeDispatch();
		const restored = new SubAgentRunManager(DOT, { stateDir, dispatch });
		expect(await restored.restore()).toBe(0);
		expect(events).toHaveLength(0);
		// The evidence survives — quarantined next to where it was, not deleted — and a
		// `.corrupt` file never matches the `.json` filter, so a later restore cannot loop on it.
		expect(existsSync(path)).toBe(false);
		expect(existsSync(`${path}.corrupt`)).toBe(true);
		expect(await restored.restore()).toBe(0);
	});

	it("finishes a persisted settlement intent after restart without releasing another writer's lease", async () => {
		const stateDir = createTempDir();
		const workspaceDir = createTempDir();
		const artifactDir = join(workspaceDir, "artifacts", "run-pending");
		mkdirSync(join(stateDir, "news"), { recursive: true });
		mkdirSync(artifactDir, { recursive: true });
		const writer = new SubAgentRunManager(DOT, { stateDir });
		const lease = acquireWorkspaceLease({
			runId: "run-pending",
			channelId: "dm_123",
			workingDirectory: workspaceDir,
		});
		expect(lease.ok).toBe(true);
		await writer.register({
			runId: "run-pending",
			channelId: "dm_123",
			runtime: "internal",
			agent: "explorer",
			label: "pending settlement",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: workspaceDir,
			artifactDir,
			leaseKey: lease.ok ? lease.leaseKey : undefined,
			mutates: "write",
		});
		const recordPath = join(stateDir, "news", "run-pending.json");
		const persisted = JSON.parse(readFileSync(recordPath, "utf-8"));
		persisted.settlementPending = {
			status: "completed",
			usage: emptyUsage(),
			usageKnown: true,
			costKnown: true,
			turns: 1,
			toolCalls: 0,
			durationMs: 500,
			finishedAt: Date.now(),
			announce: false,
		};
		writeFileSync(recordPath, `${JSON.stringify(persisted)}\n`);
		releaseWorkspaceLease(lease.ok ? lease.leaseKey : undefined, "run-pending");
		const otherLease = acquireWorkspaceLease({
			runId: "other-writer",
			channelId: "other",
			workingDirectory: workspaceDir,
		});
		expect(otherLease.ok).toBe(true);

		const restored = new SubAgentRunManager(DOT, { stateDir });
		await restored.restore();

		expect(restored.get("run-pending")).toMatchObject({
			status: "completed",
			leaseKey: undefined,
			settlementPending: undefined,
		});
		expect(
			acquireWorkspaceLease({ runId: "third-writer", channelId: "third", workingDirectory: workspaceDir }).ok,
		).toBe(false);
		releaseWorkspaceLease(otherLease.ok ? otherLease.leaseKey : undefined, "other-writer");
	});

	it("an archive write failure does not swallow the completion wake (P0-2)", async () => {
		const { ledger, records } = makeLedger();
		const { dispatch, events } = makeDispatch();
		const failingStore = {
			logSubAgentRun: async () => {
				throw new Error("Sub-agent archive queue is full.");
			},
		} as unknown as import("../src/channel/store.js").ChannelStore;
		const manager = new SubAgentRunManager(DOT, { ledger, store: failingStore, dispatch });
		await register(manager);

		await manager.settle("run-1", baseSettleInput(), { announce: true });

		expect(records).toHaveLength(1); // usage still recorded
		expect(events).toHaveLength(1); // wake still dispatched despite the archive failure
		expect(manager.get("run-1")?.status).toBe("completed");
		expect(manager.get("run-1")?.wakeEnqueued).toBe(true);
	});

	it("restore re-announces a settled record whose wake never went out (P0-2)", async () => {
		const stateDir = createTempDir();
		mkdirSync(join(stateDir, "news"), { recursive: true });

		// Simulate a crash between settlement and dispatch: settle with a dispatch that always
		// fails, so `wakeEnqueued` is never set, then persist that half-finished state.
		const writer = new SubAgentRunManager(DOT, {
			stateDir,
			dispatch: () => {
				throw new Error("dispatch unavailable");
			},
		});
		await writer.register({
			runId: "run-unwoken",
			channelId: "dm_123",
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-unwoken",
		});
		await writer.settle("run-unwoken", baseSettleInput(), { announce: true });
		expect(writer.get("run-unwoken")?.wakeEnqueued).toBeUndefined();

		const { dispatch, events } = makeDispatch();
		const restored = new SubAgentRunManager(DOT, { stateDir, dispatch });
		await restored.restore();

		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain("[SUBAGENT:run-unwoken]");
		expect(restored.get("run-unwoken")?.wakeEnqueued).toBe(true);
	});

	it("runningTaskIds reports only tasks behind a still-running run", async () => {
		const manager = new SubAgentRunManager(DOT, {});
		await register(manager, { taskId: "T-1" });
		expect(manager.runningTaskIds()).toEqual(new Set(["T-1"]));

		await manager.settle("run-1", baseSettleInput(), { announce: false });
		expect(manager.runningTaskIds()).toEqual(new Set());
	});
});

/** spec 041: short, human-typeable run ids, and prefix resolution for the commands that use them. */
describe("SubAgentRunManager run id minting and resolution (spec 041)", () => {
	it("mintRunId never reuses an id held by a known record, and register rejects a duplicate id", async () => {
		const manager = new SubAgentRunManager(DOT, {});
		const minted = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const id = manager.mintRunId();
			expect(minted.has(id)).toBe(false);
			minted.add(id);
			await register(manager, { runId: id, channelId: "dm_mint_unique" });
			// A settled run still occupies its id (only forgotten after GC), which is what
			// mintRunId must avoid reissuing; settle it so registration doesn't hit the
			// per-channel running-run cap on later iterations.
			await manager.settle(id, baseSettleInput(), { announce: false });
		}

		const dup = new SubAgentRunManager(DOT, {});
		await register(dup, { runId: "run-dup", channelId: "dm_dup" });
		await expect(register(dup, { runId: "run-dup", channelId: "dm_dup" })).rejects.toThrow("already registered");
	});

	it("resolveRef prefers an exact id, then unique prefixes (case-insensitive, run_ optional), and reports ambiguous/not_found", async () => {
		const exact = new SubAgentRunManager(DOT, {});
		await register(exact, { runId: "run_abc123", channelId: "dm_resolve" });
		await register(exact, { runId: "run_abc123xyz", channelId: "dm_resolve" });
		expect(exact.resolveRef("run_abc123")).toMatchObject({ kind: "found", record: { runId: "run_abc123" } });

		const prefix = new SubAgentRunManager(DOT, {});
		await register(prefix, { runId: "run_qwe789", channelId: "dm_resolve_prefix" });
		expect(prefix.resolveRef("qwe7")).toMatchObject({ kind: "found", record: { runId: "run_qwe789" } });
		expect(prefix.resolveRef("run_qwe7")).toMatchObject({ kind: "found", record: { runId: "run_qwe789" } });
		expect(prefix.resolveRef("QWE7")).toMatchObject({ kind: "found", record: { runId: "run_qwe789" } });

		const ambiguous = new SubAgentRunManager(DOT, {});
		await register(ambiguous, { runId: "run_zzz111", channelId: "dm_resolve_ambiguous" });
		await register(ambiguous, { runId: "run_zzz222", channelId: "dm_resolve_ambiguous" });
		const resolution = ambiguous.resolveRef("zzz");
		expect(resolution.kind).toBe("ambiguous");
		if (resolution.kind === "ambiguous") {
			expect(resolution.candidates.map((record) => record.runId).sort()).toEqual(["run_zzz111", "run_zzz222"]);
		}

		expect(exact.resolveRef("nope").kind).toBe("not_found");
	});
});

// Retention GC is independent of the process-reconciliation sweep: one daily host-wide pass drops
// a settled run and all runtime-managed artifacts together after seven days.
describe("SubAgentRunManager daily GC", () => {
	const createTempWorkspace = useTempDirs("pipiclaw-subagent-runs-gc-");

	it("keeps every managed artifact for seven days, then drops the artifacts and durable record together", async () => {
		const workspaceDir = createTempWorkspace();
		const stateDir = join(workspaceDir, "state");
		const channelId = "dm_gc";
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-gc");
		mkdirSync(artifactDir, { recursive: true });
		for (const name of ["prompt.txt", "system-prompt.txt", "events.jsonl", "stderr.log", "output.md"]) {
			writeFileSync(join(artifactDir, name), `${name} content`, "utf-8");
		}
		writeFileSync(join(artifactDir, "task-created.txt"), "keep me", "utf-8");

		const manager = new SubAgentRunManager(DOT, { stateDir });
		await manager.register({
			runId: "run-gc",
			channelId,
			runtime: "external",
			harness: "exec",
			agent: "worker",
			label: "gc me",
			source: "inline",
			tools: [],
			purpose: "work",
			workingDirectory: workspaceDir,
			artifactDir,
		});
		await manager.settle(
			"run-gc",
			{ ...baseSettleInput(), outputText: "" }, // empty outputText: settle() must not touch output.md itself
			{ announce: false },
		);
		const settledAt = manager.get("run-gc")?.settledAt;
		expect(settledAt).toBeDefined();
		if (!settledAt) throw new Error("unreachable");

		// The old 24h boundary no longer has any cleanup behavior.
		await manager.collectGarbage(settledAt + 25 * 60 * 60_000);
		for (const name of ["prompt.txt", "system-prompt.txt", "events.jsonl", "stderr.log", "output.md"]) {
			expect(existsSync(join(artifactDir, name))).toBe(true);
		}
		expect(manager.get("run-gc")).toBeDefined();

		// Just under 7d: record still present (guards against an off-by-window regression).
		await manager.collectGarbage(settledAt + 7 * 24 * 60 * 60_000 - 1);
		expect(manager.get("run-gc")).toBeDefined();

		// Past 7d: managed artifacts and both in-memory/durable records are gone. A delegated task's
		// own files are not recursively deleted merely because they share the artifact directory.
		await manager.collectGarbage(settledAt + 7 * 24 * 60 * 60_000);
		for (const name of ["prompt.txt", "system-prompt.txt", "events.jsonl", "stderr.log", "output.md"]) {
			expect(existsSync(join(artifactDir, name))).toBe(false);
		}
		expect(existsSync(join(artifactDir, "task-created.txt"))).toBe(true);
		expect(existsSync(join(stateDir, "news", "run-gc.json"))).toBe(false);
		expect(manager.get("run-gc")).toBeUndefined();
	});

	it("retains the run for a later retry when artifact deletion fails", async () => {
		const workspaceDir = createTempWorkspace();
		const stateDir = join(workspaceDir, "state");
		const channelId = "dm_gc_retry";
		const artifactDir = join(workspaceDir, "not-a-directory");
		writeFileSync(artifactDir, "blocks child unlinks", "utf-8");

		const manager = new SubAgentRunManager(DOT, { stateDir });
		await manager.register({
			runId: "run-gc-retry",
			channelId,
			runtime: "external",
			harness: "exec",
			agent: "worker",
			label: "gc me once",
			source: "inline",
			tools: [],
			purpose: "work",
			workingDirectory: workspaceDir,
			artifactDir,
		});
		await manager.settle("run-gc-retry", { ...baseSettleInput(), outputText: "" }, { announce: false });
		const settledAt = manager.get("run-gc-retry")?.settledAt;
		if (!settledAt) throw new Error("unreachable");

		await manager.collectGarbage(settledAt + 7 * 24 * 60 * 60_000);
		expect(manager.get("run-gc-retry")).toBeDefined();
		expect(existsSync(join(stateDir, "news", "run-gc-retry.json"))).toBe(true);
	});
});

describe("sub-agent run persistence per dot (spec 058, D15)", () => {
	it("restores a dot's records from its own directory and wakes each run's own channel", async () => {
		// Failure caught: a channel id is never a path segment (INV-3), so a base64 group id with `/`
		// must neither nest the record directory nor lose the channel the wake goes back to.
		const stateDir = createTempDir();
		const channelId = `group_cid${Date.now()}/eDInUw==`;

		const writer = new SubAgentRunManager(DOT, { stateDir });
		await writer.register({
			runId: "run-slash",
			channelId,
			runtime: "internal",
			agent: "explorer",
			label: "explore",
			source: "predefined",
			tools: [],
			purpose: "work",
			workingDirectory: "/tmp",
			artifactDir: "/tmp/artifacts/run-slash",
		});

		expect(readdirSync(stateDir)).toEqual(["news"]);
		expect(existsSync(join(stateDir, "news", "run-slash.json"))).toBe(true);
		const { dispatch, events } = makeDispatch();
		configureSubAgentRuntime({ stateDir, dispatch });
		expect(await restoreAllSubAgentRuns()).toBe(1);
		expect(events[0]).toMatchObject({ channelId, dot: "news", dispatchId: "subagent:news:run-slash:done" });
		configureSubAgentRuntime({});
	});
});
