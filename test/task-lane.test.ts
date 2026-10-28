import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunner } from "../src/agent/types.js";
import { TaskLane, type TaskRunnerTarget } from "../src/runtime/task-lane.js";
import { createUsage } from "../src/tasks/budget.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/contract.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { appendTaskLog, readTaskLog, resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import { readStoredTask } from "../src/tasks/store.js";
import { useTempDirs } from "./helpers/fixtures.js";
import { createFakeRunner } from "./support/fake-runner.js";

const CHANNEL = "dingtalk:dm:1";
const BODY = renderStandardTaskBody({ title: "Weekly", goal: "Ship it.", dod: "- [x] Shipped" });
const tempDir = useTempDirs("pipiclaw-task-lane-");

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** A moment `hours` from now, as the real `task_wait` stores it. */
const in_ = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

/** What a scripted step may do: the tool calls it "makes" register intents exactly as the real tools do. */
interface StepContext {
	target: TaskRunnerTarget;
	brief: string;
	runner: AgentRunner;
}
type StepResult = { text?: string; tools?: string[]; stopReason?: string; error?: string };
type Script = (context: StepContext) => Promise<StepResult | undefined> | StepResult | undefined;

interface Harness {
	lane: TaskLane;
	deskDir: string;
	deliveries: Array<{ channelId: string; text: string }>;
	/** Scripted behaviour per task, one entry per step, then `fallback`. */
	script(taskId: string, ...steps: Script[]): void;
	briefs: Record<string, string[]>;
	runners: Record<string, ReturnType<typeof createFakeRunner>>;
	disposed: string[];
	bound: { value: (channelId: string, desk: string) => boolean };
	pending: Array<{ taskId: string; runId: string; startedAt?: number }>;
	cancelledRuns: string[];
	enabled: { value: boolean };
	/** Fast-forward the lane's clock. */
	skew: { ms: number };
	task(id: string, fields?: Partial<TaskFrontmatter>, desk?: string): Promise<void>;
	/** Scan, then wait for every step in flight to finish. */
	settle(): Promise<void>;
}

function makeHarness(overrides: { stepTimeLimitMs?: number } = {}): Harness {
	// Time the lane sees: real time plus whatever a test fast-forwards (back-off, waits).
	const skew = { ms: 0 };
	const deskDirs = new Map<string, string>([
		["main", tempDir()],
		["other", tempDir()],
	]);
	const scripts = new Map<string, Script[]>();
	const briefs: Record<string, string[]> = {};
	const runners: Harness["runners"] = {};
	const disposed: string[] = [];
	const bound = { value: (_channelId: string, _desk: string) => true };
	const enabled = { value: true };
	const pending: Harness["pending"] = [];
	const cancelledRuns: string[] = [];
	const deliveries: Harness["deliveries"] = [];
	const activeTasks = new Set<Promise<void>>();
	// A script that runs out parks the task for a day, so a test never spins a task up to its budget by accident.
	const defaultStep: Script = ({ target }) => {
		target.session.intent().waitUntil = new Date(Date.now() + 86_400_000).toISOString();
		return { text: "default", tools: ["task_wait"] };
	};

	const lane = new TaskLane({
		getActiveDesks: () => [...deskDirs].map(([desk, deskDir]) => ({ desk, deskDir })),
		getDeskDir: (desk) => deskDirs.get(desk),
		isBoundTo: (channelId, desk) => bound.value(channelId, desk),
		isReachable: () => true,
		createTaskRunner: (target) => {
			let step: StepContext | undefined;
			const runner = createFakeRunner({
				run: vi.fn(async (info) => {
					briefs[target.taskId] = [...(briefs[target.taskId] ?? []), info.text];
					const queue = scripts.get(target.taskId) ?? [];
					const script = queue.shift() ?? defaultStep;
					step = { target, brief: info.text, runner };
					const result = (await script(step)) ?? { text: "ok", tools: ["bash"] };
					return {
						stopReason: result.stopReason ?? "stop",
						...(result.error ? { errorMessage: result.error } : {}),
						finalText: result.text ?? "",
						toolsUsed: result.tools ?? [],
						assistantCost: { usd: 0.01, estimated: false },
					};
				}),
				dispose: vi.fn(async () => {
					disposed.push(target.taskId);
				}),
				contextIncludes: vi.fn(async (needle: string) =>
					(briefs[target.taskId] ?? []).some((b) => b.includes(needle)),
				),
				getActivity: () => ({ pendingTools: [], toolsDone: 0 }),
			});
			runners[target.taskId] = runner;
			return runner;
		},
		getRuns: (desk) =>
			({
				list: () =>
					pending
						.filter(() => desk === "main")
						.map((entry) => ({
							runId: entry.runId,
							taskId: entry.taskId,
							agent: "builder",
							runtime: "internal",
							startedAt: entry.startedAt ?? Date.now(),
							artifactDir: "/nowhere",
						})),
				cancel: async (runId: string) => {
					cancelledRuns.push(runId);
					const index = pending.findIndex((entry) => entry.runId === runId);
					if (index >= 0) pending.splice(index, 1);
					return "cancelled";
				},
			}) as never,
		getJobs: () => ({ list: async () => [], cancel: async () => [] }) as never,
		store: {} as never,
		deliver: async (_desk, channelId, text) => {
			deliveries.push({ channelId, text });
			return true;
		},
		isEnabled: () => enabled.value,
		activeTasks,
		now: () => Date.now() + skew.ms,
		timing: {
			stepTimeLimitMs: overrides.stepTimeLimitMs ?? 60_000,
			notifyDebounceMs: 1,
			errorBackoffMs: [60_000, 300_000],
		},
	});

	return {
		lane,
		get deskDir() {
			return deskDirs.get("main") as string;
		},
		deliveries,
		script: (taskId, ...steps) => scripts.set(taskId, [...steps]),
		briefs,
		runners,
		disposed,
		bound,
		pending,
		cancelledRuns,
		enabled,
		skew,
		task: async (id, fields = {}, desk = "main") => {
			const deskDir = deskDirs.get(desk) as string;
			mkdirSync(join(deskDir, "tasks"), { recursive: true });
			writeFileSync(
				join(deskDir, "tasks", `${id}.md`),
				renderTaskDocument({ state: "queued", channel: CHANNEL, usage: createUsage(), ...fields }, BODY),
			);
		},
		settle: async () => {
			await lane.runOnce();
			while (activeTasks.size > 0) await Promise.all([...activeTasks]);
		},
	};
}

/** Tools register intents on the session, as `task_ask` / `task_wait` / `task_close` do. */
const ask =
	(question: string): Script =>
	({ target }) => {
		target.session.intent().ask = { question };
		return { text: "asked", tools: ["task_ask"] };
	};
const wait =
	(until: string): Script =>
	({ target }) => {
		target.session.intent().waitUntil = until;
		return { text: "waiting", tools: ["task_wait"] };
	};
const close =
	(outcome: "complete" | "cancel", note = "done"): Script =>
	({ target }) => {
		target.session.intent().close = { outcome, note };
		return { text: "finished", tools: ["task_close"] };
	};

let harness: Harness;
beforeEach(() => {
	harness = makeHarness();
});
afterEach(async () => {
	harness.lane.stop();
	await resetTaskLogAppenders();
});

const state = async (id: string, desk = "main") => {
	const deskDir = desk === "main" ? harness.deskDir : undefined;
	return (await readStoredTask(deskDir as string, id))?.fields;
};

describe("execution slots (spec 064, D12)", () => {
	it("runs at most three tasks per desk and five in all, oldest project first", async () => {
		const gate = deferred();
		let arrived = 0;
		const waiters: Array<() => void> = [];
		const hold: Script = async () => {
			arrived++;
			for (const wake of waiters) wake();
			await gate.promise;
			return { text: "held", tools: ["bash"] };
		};
		const arrivals = (count: number) =>
			new Promise<void>((resolve) => {
				const check = () => arrived >= count && resolve();
				waiters.push(check);
				check();
			});
		// "a" is the youngest project in its desk, so it is the one left in line.
		for (const [id, startedAt] of [
			["a", "2026-10-04T09:00:00+08:00"],
			["b", "2026-10-01T09:00:00+08:00"],
			["c", "2026-10-02T09:00:00+08:00"],
			["d", "2026-10-03T09:00:00+08:00"],
		] as const) {
			await harness.task(id, { usage: { ...createUsage(), startedAt } });
			harness.script(id, hold);
		}
		for (const id of ["e", "f", "g"]) {
			await harness.task(id, {}, "other");
			harness.script(id, hold);
		}
		await harness.lane.runOnce();
		await arrivals(5);

		expect((await Promise.all(["a", "b", "c", "d"].map((id) => state(id)))).map((f) => f?.state)).toEqual([
			"queued",
			"running",
			"running",
			"running",
		]);
		// The other desk fills the global five (two of its three), whatever its own limit would allow.
		expect(Object.keys(harness.runners).sort()).toEqual(["b", "c", "d", "e", "f"]);
		gate.resolve();
		await harness.settle();
	});

	it("keeps a slot while it waits for results", async () => {
		for (const id of ["w1", "w2", "w3"]) {
			await harness.task(id);
			harness.script(id, () => ({ text: "dispatched", tools: ["subagent"] }));
			harness.pending.push({ taskId: id, runId: `run_${id}` });
		}
		await harness.settle();
		expect((await Promise.all(["w1", "w2", "w3"].map((id) => state(id)))).map((f) => f?.waiting?.kind)).toEqual([
			"work",
			"work",
			"work",
		]);
		await harness.task("late");
		await harness.settle();
		expect((await state("late"))?.state).toBe("queued");
		expect(harness.briefs.late).toBeUndefined();
		expect(harness.disposed).toEqual([]);
	});

	it("gives its slot back while it waits for the user or a moment, or is paused", async () => {
		await harness.task("u");
		await harness.task("t");
		await harness.task("p", {
			state: "paused",
			paused: { by: "user", reason: "hold", at: "2026-10-01T09:00:00+08:00" },
		});
		harness.script("u", ask("q?"));
		harness.script("t", wait(in_(2)));
		await harness.settle();
		expect(harness.disposed.sort()).toEqual(["t", "u"]);

		// Had they kept their slots, only one of these could run at a time.
		const gate = deferred();
		let running = 0;
		let peak = 0;
		for (const id of ["h1", "h2", "h3"]) {
			await harness.task(id);
			harness.script(id, async () => {
				peak = Math.max(peak, ++running);
				await Promise.resolve();
				await gate.promise;
				return { text: "held", tools: ["bash"] };
			});
		}
		await harness.lane.runOnce();
		while (running < 3) await new Promise((resolve) => setTimeout(resolve, 2));
		expect(peak).toBe(3);
		gate.resolve();
		await harness.settle();
	});
});

describe("a step's end (D8)", () => {
	it("asks the user, waits for a moment, or closes — each by what the leader registered", async () => {
		await harness.task("asker");
		await harness.task("sleeper");
		await harness.task("finisher");
		harness.script("asker", ask("要合并吗？"));
		harness.script("sleeper", wait(in_(2)));
		harness.script("finisher", close("complete", "all good"));
		await harness.settle();

		expect(await state("asker")).toMatchObject({
			state: "waiting",
			waiting: { kind: "user", question: "要合并吗？" },
		});
		expect(await state("sleeper")).toMatchObject({ state: "waiting", waiting: { kind: "time" } });
		expect(await state("finisher")).toBeUndefined();
		expect((await readStoredTask(harness.deskDir, "finisher", true))?.fields.outcome).toBe("completed");
		const texts = harness.deliveries.map((delivery) => delivery.text);
		expect(texts.some((text) => text.includes("需要你的决定") && text.includes("要合并吗？"))).toBe(true);
		expect(texts.some((text) => text.includes("已完成") && text.includes("`finisher`"))).toBe(true);
		const log = await readTaskLog(harness.deskDir, "asker");
		expect(log.map((record) => record.kind)).toEqual(["step", "step_end"]);
		expect(log[1]).toMatchObject({ result: "ok", next: "user", note: "asked", tools: ["task_ask"] });
	});

	it("opens the next step at once when nothing is in flight, with the delta brief — and stops at the budget", async () => {
		await harness.task("loop", { budget: { steps: 3 } });
		harness.script(
			"loop",
			() => ({ text: "one", tools: ["bash"] }),
			() => ({ text: "two", tools: ["bash"] }),
			() => ({
				text: "three",
				tools: ["bash"],
			}),
		);
		await harness.settle();

		const briefs = harness.briefs.loop ?? [];
		expect(briefs).toHaveLength(3);
		expect(briefs[0]).toContain("<task_contract");
		expect(briefs[1]).not.toContain("<task_contract");
		expect(await state("loop")).toMatchObject({ state: "paused", paused: { by: "runtime" }, usage: { steps: 3 } });
		expect(harness.deliveries.at(-1)?.text).toMatch(/已暂停.*\+steps 10/s);
	});
});

describe("results and messages wake the task (D9, INV-6)", () => {
	it("wakes a work wait when a result is logged and the lane is told, with the result in the brief", async () => {
		await harness.task("waiter");
		harness.pending.push({ taskId: "waiter", runId: "run_k" });
		harness.script(
			"waiter",
			() => ({ text: "dispatched", tools: ["subagent"] }),
			() => ({ text: "checked", tools: ["read"] }),
			close("complete"),
		);
		await harness.settle();
		expect((await state("waiter"))?.waiting?.kind).toBe("work");
		expect(harness.runners.waiter).toBeDefined();
		expect(harness.disposed).not.toContain("waiter");

		harness.pending.length = 0;
		await appendTaskLog(harness.deskDir, "waiter", {
			kind: "settle",
			ref: "run_k",
			status: "completed",
			tail: "RESULT_TAIL",
		});
		await harness.settle();

		expect(harness.briefs.waiter?.[1]).toContain("RESULT_TAIL");
		expect(harness.briefs.waiter?.[1]).not.toContain("<task_contract");
	});

	it("leaves a task that asked the user waiting through a result, and wakes it for the user's message", async () => {
		await harness.task("asker");
		harness.script("asker", ask("q?"), wait(in_(1)));
		await harness.settle();
		await appendTaskLog(harness.deskDir, "asker", { kind: "settle", ref: "run_x", status: "completed" });
		await harness.settle();
		expect((await state("asker"))?.state).toBe("waiting");
		expect(harness.briefs.asker).toHaveLength(1);

		await appendTaskLog(harness.deskDir, "asker", {
			kind: "message",
			from: "Alice",
			channel: CHANNEL,
			text: "合并吧",
		});
		await harness.settle();
		expect(harness.briefs.asker).toHaveLength(2);
		expect(harness.briefs.asker?.[1]).toContain("合并吧");
		expect(harness.briefs.asker?.[1]).toContain("run_x");
	});

	it("wakes a time wait when due, and does not before", async () => {
		await harness.task("sleeper");
		harness.script("sleeper", wait(in_(2)), wait(in_(5)));
		await harness.settle();
		await harness.settle();
		expect(harness.briefs.sleeper).toHaveLength(1);

		const document = await readStoredTask(harness.deskDir, "sleeper");
		const due = {
			kind: "time" as const,
			until: new Date(Date.now() - 1000).toISOString(),
			since: "2026-10-01T09:00:00+08:00",
		};
		writeFileSync(
			document?.path as string,
			renderTaskDocument({ ...(document?.fields as TaskFrontmatter), waiting: due }, document?.body ?? ""),
		);
		await harness.settle();
		expect(harness.briefs.sleeper).toHaveLength(2);
	});
});

describe("runtime guards (D16)", () => {
	it("pauses a loop that talks to itself after two steps with no tool call, and tells the user", async () => {
		await harness.task("idle");
		harness.script(
			"idle",
			() => ({ text: "thinking", tools: [] }),
			() => ({ text: "still thinking", tools: [] }),
		);
		await harness.settle();
		expect(await state("idle")).toMatchObject({ state: "paused", paused: { by: "runtime" } });
		expect(harness.briefs.idle).toHaveLength(2);
		expect(harness.deliveries.at(-1)?.text).toContain("没有任何工具调用");
		expect(harness.disposed).toContain("idle");
	});

	it("backs a failing task off, and stops it on the third error in a row", async () => {
		await harness.task("flaky");
		const fail: Script = () => ({ stopReason: "error", error: "provider down", text: "" });
		harness.script("flaky", fail, fail, fail);
		await harness.settle();
		// The first failure puts the task back in line with a pause before it is admitted again.
		expect(harness.briefs.flaky).toHaveLength(1);
		expect(await state("flaky")).toMatchObject({ state: "queued" });
		await harness.settle();
		expect(harness.briefs.flaky).toHaveLength(1);

		harness.skew.ms += 61_000;
		await harness.settle();
		expect(harness.briefs.flaky).toHaveLength(2);
		// The second failure waits longer than the first.
		harness.skew.ms += 61_000;
		await harness.settle();
		expect(harness.briefs.flaky).toHaveLength(2);

		harness.skew.ms += 5 * 60_000;
		await harness.settle();
		expect(await state("flaky")).toMatchObject({ state: "paused", paused: { by: "runtime" } });
		expect(harness.deliveries.at(-1)?.text).toContain("连续 3 步出错");
		const log = await readTaskLog(harness.deskDir, "flaky");
		expect(log.find((record) => record.kind === "step_end")).toMatchObject({
			result: "error",
			error: "provider down",
		});
	});

	it("stops a step that outlives its time limit, and pauses the task on the second timeout", async () => {
		harness = makeHarness({ stepTimeLimitMs: 20 });
		await harness.task("slow");
		const hang: Script = ({ runner }) =>
			new Promise((resolve) => {
				vi.mocked(runner.abort).mockImplementation(async () => resolve({ text: "cut off", tools: [] }));
			});
		harness.script("slow", hang, hang);
		await harness.settle();
		await harness.settle();

		const ends = (await readTaskLog(harness.deskDir, "slow")).filter((record) => record.kind === "step_end");
		expect(ends.map((record) => (record.kind === "step_end" ? record.result : ""))).toEqual(["timeout", "timeout"]);
		expect(await state("slow")).toMatchObject({ state: "paused", paused: { by: "runtime" } });
		expect(harness.runners.slow?.requestStop).toBeDefined();
	});
});

describe("control from the chat (D24)", () => {
	it("pauses a running step without touching the work it started, and the resume sees what came back", async () => {
		await harness.task("busy");
		harness.pending.push({ taskId: "busy", runId: "run_live" });
		const started = deferred();
		harness.script(
			"busy",
			async ({ runner }) => {
				started.resolve();
				await new Promise<void>((resolve) => vi.mocked(runner.abort).mockImplementation(async () => resolve()));
				return { text: "stopped midway", tools: [] };
			},
			() => ({ text: "after resume", tools: ["bash"] }),
		);
		const running = harness.lane.runOnce();
		await started.promise;
		expect(await harness.lane.pause("main", "busy", { by: "user", reason: "hold" })).toEqual({ kind: "ok" });
		await running;
		while (true) {
			if ((await state("busy"))?.state === "paused" && harness.disposed.includes("busy")) break;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}

		const ends = (await readTaskLog(harness.deskDir, "busy")).filter((record) => record.kind === "step_end");
		expect(ends[0]).toMatchObject({ result: "aborted", next: "paused" });
		// The delegation keeps running and is not cancelled by a pause.
		expect(harness.cancelledRuns).toEqual([]);

		harness.pending.length = 0;
		await appendTaskLog(harness.deskDir, "busy", { kind: "settle", ref: "run_live", status: "completed" });
		expect(await harness.lane.resume("main", "busy", { steps: 5 })).toEqual({ kind: "ok" });
		await harness.settle();
		expect(harness.briefs.busy?.[1]).toContain("run_live");
		expect(harness.briefs.busy?.[1]).toContain("恢复");
	});

	it("injects a message into the running step, and only queues it when no step is running", async () => {
		await harness.task("busy");
		const started = deferred();
		const release = deferred();
		harness.script("busy", async () => {
			started.resolve();
			await release.promise;
			return { text: "done", tools: ["bash"] };
		});
		const running = harness.lane.runOnce();
		await started.promise;
		const outcome = await harness.lane.message("main", "busy", { from: "Alice", channel: CHANNEL, text: "多做一点" });
		expect(outcome).toEqual({ kind: "injected" });
		expect(harness.runners.busy?.queueSteer).toHaveBeenCalledWith(expect.stringContaining("多做一点"), "Alice");
		release.resolve();
		await running;
		while ((await state("busy"))?.state === "running") await new Promise((resolve) => setTimeout(resolve, 5));

		// The injected message was seen by the step it joined: the next brief does not repeat it.
		const records = await readTaskLog(harness.deskDir, "busy");
		expect(records.find((record) => record.kind === "message")).toMatchObject({ injected: 1 });
		harness.script("busy", () => ({ text: "next", tools: ["bash"] }));
		await harness.settle();
		expect(harness.briefs.busy?.at(-1) ?? "").not.toContain("多做一点");
		expect(await harness.lane.message("main", "ghost", { from: "A", channel: CHANNEL, text: "x" })).toEqual({
			kind: "not_found",
		});
	});

	it("cancels a task together with the delegations it started, and tells another channel's report channel", async () => {
		await harness.task("doomed", { state: "waiting", waiting: { kind: "work", since: "2026-10-01T09:00:00+08:00" } });
		harness.pending.push({ taskId: "doomed", runId: "run_a" });
		const outcome = await harness.lane.cancel("main", "doomed", { by: "user", note: "no", channel: "dingtalk:dm:2" });
		expect(outcome).toEqual({ kind: "cancelled", cancelled: ["run_a"] });
		expect(harness.cancelledRuns).toEqual(["run_a"]);
		expect((await readStoredTask(harness.deskDir, "doomed", true))?.fields.outcome).toBe("cancelled");
		expect(harness.deliveries.at(-1)).toMatchObject({ channelId: CHANNEL });
		expect(harness.deliveries.at(-1)?.text).toContain("已被取消");
		// Asked from the report channel itself, the command's own reply is the confirmation.
		await harness.task("again");
		harness.deliveries.length = 0;
		await harness.lane.cancel("main", "again", { by: "user", note: "no", channel: CHANNEL });
		expect(harness.deliveries).toEqual([]);
	});
});

describe("a task whose report channel cannot be reached (INV-7)", () => {
	it("is frozen: no step, no slot, no runner — and carries on from where it was when the channel returns", async () => {
		await harness.task("frozen");
		await harness.task("free");
		harness.bound.value = (channelId) => channelId !== "dingtalk:dm:gone";
		await harness.task("orphan", { channel: "dingtalk:dm:gone" });
		await harness.settle();
		expect(harness.briefs.orphan).toBeUndefined();
		expect((await state("orphan"))?.state).toBe("queued");
		// Inputs still land in the log while it is frozen.
		const snapshot = await harness.lane.snapshot("main", "orphan");
		expect(snapshot[0]).toMatchObject({ frozen: true });
		expect(await harness.lane.message("main", "orphan", { from: "A", channel: CHANNEL, text: "hi" })).toEqual({
			kind: "held_frozen",
		});

		harness.bound.value = () => true;
		await harness.settle();
		expect(harness.briefs.orphan?.[0]).toContain("hi");
	});

	it("takes no new step while tools.tasks is off, but keeps maintaining", async () => {
		await harness.task("idle");
		harness.enabled.value = false;
		await harness.settle();
		expect(harness.briefs.idle).toBeUndefined();
		harness.enabled.value = true;
		await harness.settle();
		expect(harness.briefs.idle).toHaveLength(1);
	});
});

describe("restart (D10, D11)", () => {
	it("repairs a step the last process never finished before deciding anything else", async () => {
		await harness.task("crashed", { state: "running", usage: { ...createUsage(), steps: 2 } });
		await appendTaskLog(harness.deskDir, "crashed", { kind: "step", seq: 3, reason: "continue", brief: "delta" });
		await harness.settle();

		const records = await readTaskLog(harness.deskDir, "crashed");
		expect(records.filter((record) => record.kind === "step_end")[0]).toMatchObject({
			seq: 3,
			result: "interrupted",
		});
		// Then it ran again, as step 4 — the interrupted one is counted, never silently dropped.
		expect(harness.briefs.crashed).toHaveLength(1);
		expect(
			records.filter((record) => record.kind === "step").map((record) => (record.kind === "step" ? record.seq : 0)),
		).toEqual([3, 4]);
		expect((await state("crashed"))?.usage?.steps).toBe(4);
	});

	it("stops the step in flight on shutdown without writing its end — the next start does", async () => {
		await harness.task("running");
		const started = deferred();
		harness.script("running", async ({ runner }) => {
			started.resolve();
			await new Promise<void>((resolve) => vi.mocked(runner.abort).mockImplementation(async () => resolve()));
			return { text: "cut", tools: [] };
		});
		const scanning = harness.lane.runOnce();
		await started.promise;
		harness.lane.stop();
		await scanning;
		await new Promise((resolve) => setTimeout(resolve, 20));

		const records = await readTaskLog(harness.deskDir, "running");
		expect(records.map((record) => record.kind)).toEqual(["step"]);
		expect((await state("running"))?.state).toBe("running");
	});
});
