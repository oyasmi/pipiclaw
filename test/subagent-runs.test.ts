import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import type { LoggedSubAgentRun } from "../src/runtime/store.js";
import {
	configureSubAgentRuntime,
	getSubAgentRunManager,
	MAX_RUNNING_SUBAGENT_RUNS_PER_HOST,
	type SettleInput,
	SubAgentRunManager,
} from "../src/subagents/runs.js";
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
		expect(events[0]?.internalWake).toEqual({
			kind: "subagent",
			resourceId: "run-1",
			taskId: "T-7",
			dispatchId: "subagent:dm_123:run-1:done",
		});
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

	it("consumes an exact durable task wake once and rejects its replay", async () => {
		const manager = new SubAgentRunManager("dm_123", {});
		await register(manager, { taskId: "T-once" });
		await manager.settle("run-1", baseSettleInput(), { announce: false });
		const dispatchId = "subagent:dm_123:run-1:done";
		await expect(manager.beginWakeConsumption("run-1", "T-once", dispatchId)).resolves.toBe(true);
		await manager.finishWakeConsumption("run-1", dispatchId);
		await expect(manager.beginWakeConsumption("run-1", "T-once", dispatchId)).resolves.toBe(false);
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

	it("an archive write failure does not swallow the completion wake (P0-2)", async () => {
		const { ledger, records } = makeLedger();
		const { dispatch, events } = makeDispatch();
		const failingStore = {
			logSubAgentRun: async () => {
				throw new Error("Sub-agent archive queue is full.");
			},
		} as unknown as import("../src/runtime/store.js").ChannelStore;
		const manager = new SubAgentRunManager("dm_123", { ledger, store: failingStore, dispatch });
		await register(manager);

		await manager.settle("run-1", baseSettleInput(), { announce: true });

		expect(records).toHaveLength(1); // usage still recorded
		expect(events).toHaveLength(1); // wake still dispatched despite the archive failure
		expect(manager.get("run-1")?.status).toBe("completed");
		expect(manager.get("run-1")?.wakeEnqueued).toBe(true);
	});

	it("restore re-announces a settled record whose wake never went out (P0-2)", async () => {
		const stateDir = createTempDir();
		mkdirSync(join(stateDir, "dm_123"), { recursive: true });

		// Simulate a crash between settlement and dispatch: settle with a dispatch that always
		// fails, so `wakeEnqueued` is never set, then persist that half-finished state.
		const writer = new SubAgentRunManager("dm_123", {
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
		const restored = new SubAgentRunManager("dm_123", { stateDir, dispatch });
		await restored.restore();

		expect(events).toHaveLength(1);
		expect(events[0]?.text).toContain("[SUBAGENT:run-unwoken]");
		expect(restored.get("run-unwoken")?.wakeEnqueued).toBe(true);
	});

	it("runningTaskIds reports only tasks behind a still-running run", async () => {
		const manager = new SubAgentRunManager("dm_123", {});
		await register(manager, { taskId: "T-1" });
		expect(manager.runningTaskIds()).toEqual(new Set(["T-1"]));

		await manager.settle("run-1", baseSettleInput(), { announce: false });
		expect(manager.runningTaskIds()).toEqual(new Set());
	});
});

/** spec 041: short, human-typeable run ids, and prefix resolution for the commands that use them. */
describe("SubAgentRunManager run id minting and resolution (spec 041)", () => {
	it("mintRunId produces run_ + 6 lowercase chars from a misread-resistant alphabet", () => {
		const manager = new SubAgentRunManager("dm_mint", {});
		for (let i = 0; i < 50; i++) {
			expect(manager.mintRunId()).toMatch(/^run_[23456789abcdefghjkmnpqrstvwxyz]{6}$/);
		}
	});

	it("mintRunId never reuses an id already held by a known record", async () => {
		const manager = new SubAgentRunManager("dm_mint_unique", {});
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
	});

	it("register rejects a runId that is already registered", async () => {
		const manager = new SubAgentRunManager("dm_dup", {});
		await register(manager, { runId: "run-dup", channelId: "dm_dup" });
		await expect(register(manager, { runId: "run-dup", channelId: "dm_dup" })).rejects.toThrow("already registered");
	});

	it("resolveRef matches an exact id first, even if it happens to be a prefix of another", async () => {
		const manager = new SubAgentRunManager("dm_resolve", {});
		await register(manager, { runId: "run_abc123", channelId: "dm_resolve" });
		await register(manager, { runId: "run_abc123xyz", channelId: "dm_resolve" });
		const resolution = manager.resolveRef("run_abc123");
		expect(resolution).toMatchObject({ kind: "found", record: { runId: "run_abc123" } });
	});

	it("resolveRef matches a unique prefix, with or without the run_ prefix, case-insensitively", async () => {
		const manager = new SubAgentRunManager("dm_resolve_prefix", {});
		await register(manager, { runId: "run_qwe789", channelId: "dm_resolve_prefix" });
		expect(manager.resolveRef("qwe7")).toMatchObject({ kind: "found", record: { runId: "run_qwe789" } });
		expect(manager.resolveRef("run_qwe7")).toMatchObject({ kind: "found", record: { runId: "run_qwe789" } });
		expect(manager.resolveRef("QWE7")).toMatchObject({ kind: "found", record: { runId: "run_qwe789" } });
	});

	it("resolveRef reports ambiguous when a prefix matches more than one run", async () => {
		const manager = new SubAgentRunManager("dm_resolve_ambiguous", {});
		await register(manager, { runId: "run_zzz111", channelId: "dm_resolve_ambiguous" });
		await register(manager, { runId: "run_zzz222", channelId: "dm_resolve_ambiguous" });
		const resolution = manager.resolveRef("zzz");
		expect(resolution.kind).toBe("ambiguous");
		if (resolution.kind === "ambiguous") {
			expect(resolution.candidates.map((record) => record.runId).sort()).toEqual(["run_zzz111", "run_zzz222"]);
		}
	});

	it("resolveRef reports not_found for an unknown id or prefix", () => {
		const manager = new SubAgentRunManager("dm_resolve_missing", {});
		expect(manager.resolveRef("nope").kind).toBe("not_found");
	});
});

// Spec 042, D9: GC used to run only inside restore() — a long-lived daemon that never restarted
// accumulated terminal records and artifacts without bound. It is now folded into the periodic
// sweep, with a two-tier retention: auxiliary artifacts at 24h, the run record + output.md at 7d.
describe("SubAgentRunManager sweep-based GC (spec 042, D9)", () => {
	const createTempWorkspace = useTempDirs("pipiclaw-subagent-runs-gc-");

	it("cleans auxiliary artifacts after 24h but keeps output.md and the record, then drops both after 7d", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dm_gc";
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-gc");
		mkdirSync(artifactDir, { recursive: true });
		for (const name of ["prompt.txt", "system-prompt.txt", "events.jsonl", "stderr.log", "output.md"]) {
			writeFileSync(join(artifactDir, name), `${name} content`, "utf-8");
		}

		const manager = new SubAgentRunManager(channelId, {});
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

		// Just under 24h: nothing cleaned yet.
		await manager.sweep(settledAt + 23 * 60 * 60_000);
		for (const name of ["prompt.txt", "system-prompt.txt", "events.jsonl", "stderr.log", "output.md"]) {
			expect(existsSync(join(artifactDir, name))).toBe(true);
		}
		expect(manager.get("run-gc")).toBeDefined();

		// Just past 24h: auxiliary artifacts gone, output.md and the record survive.
		await manager.sweep(settledAt + 25 * 60 * 60_000);
		for (const name of ["prompt.txt", "system-prompt.txt", "events.jsonl", "stderr.log"]) {
			expect(existsSync(join(artifactDir, name))).toBe(false);
		}
		expect(existsSync(join(artifactDir, "output.md"))).toBe(true);
		expect(manager.get("run-gc")).toBeDefined();

		// Just under 7d: record still present (guards against an off-by-window regression).
		await manager.sweep(settledAt + 6 * 24 * 60 * 60_000 + 60_000);
		expect(manager.get("run-gc")).toBeDefined();

		// Past 7d: the record itself is forgotten.
		await manager.sweep(settledAt + 7 * 24 * 60 * 60_000 + 60_000);
		expect(manager.get("run-gc")).toBeUndefined();
	});

	it("does not re-attempt auxiliary cleanup on every sweep tick once already cleaned", async () => {
		const workspaceDir = createTempWorkspace();
		const channelId = "dm_gc_once";
		const artifactDir = join(workspaceDir, channelId, "subagent-artifacts", "run-gc-once");
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "events.jsonl"), "x", "utf-8");

		const manager = new SubAgentRunManager(channelId, {});
		await manager.register({
			runId: "run-gc-once",
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
		await manager.settle("run-gc-once", { ...baseSettleInput(), outputText: "" }, { announce: false });
		const settledAt = manager.get("run-gc-once")?.settledAt;
		if (!settledAt) throw new Error("unreachable");

		await manager.sweep(settledAt + 25 * 60 * 60_000);
		expect(manager.get("run-gc-once")?.auxiliaryArtifactsCleaned).toBe(true);

		// Recreate the file (simulating nothing in particular — just proving a second sweep tick
		// does not try to unlink it again because the marker is already set) and sweep again.
		writeFileSync(join(artifactDir, "events.jsonl"), "recreated", "utf-8");
		await manager.sweep(settledAt + 26 * 60 * 60_000);
		expect(existsSync(join(artifactDir, "events.jsonl"))).toBe(true);
	});
});
