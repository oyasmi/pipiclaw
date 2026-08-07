import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import type { LoggedSubAgentRun } from "../src/runtime/store.js";
import { type SettleInput, SubAgentRunManager } from "../src/subagents/runs.js";
import type { UsageLedgerEntry } from "../src/usage/ledger.js";
import { useTempDirs } from "./helpers/fixtures.js";

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
		} as unknown as import("../src/runtime/store.js").ChannelStore,
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
	it("settling inline (announce:false) records usage/archive once and marks wakeEnqueued without dispatching", async () => {
		const { ledger, records } = makeLedger();
		const { store, archived } = makeStore();
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager("dm_123", { ledger, store, dispatch });
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
		const manager = new SubAgentRunManager("dm_123", { ledger, store, dispatch });
		await register(manager, { taskId: "T-7" });

		await manager.settle("run-1", baseSettleInput({ outputText: "Found the bug in src/index.ts." }), {
			announce: true,
		});

		expect(events).toHaveLength(1);
		expect(events[0]?.dispatchId).toBe("subagent:dm_123:run-1:done");
		expect(events[0]?.text).toContain("[SUBAGENT:run-1]");
		expect(events[0]?.text).toContain("It belongs to task T-7.");
		expect(events[0]?.text).toContain("Found the bug in src/index.ts.");
		expect(events[0]?.text).toContain("[SILENT]");
	});

	it("settle is idempotent: a second call for the same run neither re-bills nor re-announces", async () => {
		const { ledger, records } = makeLedger();
		const { store, archived } = makeStore();
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager("dm_123", { ledger, store, dispatch });
		await register(manager);

		const input = baseSettleInput();
		await manager.settle("run-1", input, { announce: true });
		await manager.settle("run-1", input, { announce: true });
		await manager.settle("run-1", input, { announce: false });

		expect(events).toHaveLength(1);
		expect(records).toHaveLength(1);
		expect(archived).toHaveLength(1);
	});

	it("cancel invokes the registered handle and does not itself dispatch a wake", async () => {
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager("dm_123", { dispatch });
		await register(manager);
		let cancelled = false;
		manager.registerCancelHandle("run-1", () => {
			cancelled = true;
		});

		const status = await manager.cancel("run-1");

		expect(cancelled).toBe(true);
		expect(status).toBe("running"); // the caller's own settle() (triggered by its abort) drives the terminal status
		expect(events).toHaveLength(0);
	});

	it("cancel with no live handle marks the run lost without dispatching", async () => {
		const { dispatch, events } = makeDispatch();
		const manager = new SubAgentRunManager("dm_123", { dispatch });
		await register(manager);

		const status = await manager.cancel("run-1");

		expect(status).toBe("lost");
		expect(events).toHaveLength(0);
		expect(manager.get("run-1")?.status).toBe("lost");
	});

	it("restore settles a still-running internal run as lost and wakes the channel exactly once", async () => {
		const stateDir = createTempDir();
		mkdirSync(join(stateDir, "dm_123"), { recursive: true });
		const { ledger } = makeLedger();
		const { store } = makeStore();
		const { dispatch, events } = makeDispatch();

		const writer = new SubAgentRunManager("dm_123", { stateDir });
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
		const restored = new SubAgentRunManager("dm_123", { stateDir, ledger, store, dispatch });
		const count = await restored.restore();

		expect(count).toBe(1);
		expect(restored.get("run-orphan")?.status).toBe("lost");
		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain("[SUBAGENT:run-orphan]");
		expect(events[0]?.text).toContain("lost");

		const persisted = JSON.parse(readFileSync(join(stateDir, "dm_123", "run-orphan.json"), "utf-8"));
		expect(persisted.status).toBe("lost");
		expect(persisted.wakeEnqueued).toBe(true);
	});

	it("restore leaves an already-terminal record alone", async () => {
		const stateDir = createTempDir();
		mkdirSync(join(stateDir, "dm_123"), { recursive: true });
		const { dispatch, events } = makeDispatch();

		const writer = new SubAgentRunManager("dm_123", { stateDir });
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

		const restored = new SubAgentRunManager("dm_123", { stateDir, dispatch });
		await restored.restore();

		expect(events).toHaveLength(0);
		expect(restored.get("run-done")?.status).toBe("completed");
	});

	it("runningTaskIds reports only tasks behind a still-running run", async () => {
		const manager = new SubAgentRunManager("dm_123", {});
		await register(manager, { taskId: "T-1" });
		expect(manager.runningTaskIds()).toEqual(new Set(["T-1"]));

		await manager.settle("run-1", baseSettleInput(), { announce: false });
		expect(manager.runningTaskIds()).toEqual(new Set());
	});
});
