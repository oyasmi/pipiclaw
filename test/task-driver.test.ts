import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { discoverTaskChannels, TaskDriver } from "../src/runtime/task-driver.js";
import type { PipiclawTaskDriverSettings } from "../src/settings.js";
import { renderTaskDocument } from "../src/shared/task-ledger.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import { finishTaskAttempt } from "../src/tasks/store.js";
import { manageTask } from "../src/tools/task-manage.js";

const NOW = new Date("2026-07-10T12:00:00+08:00");
const SETTINGS: PipiclawTaskDriverSettings = {
	continuationDelayMinutes: 5,
	stalledRetryMinutes: 60,
	maxDispatchesPerTick: 4,
	maxSleepMinutes: 15,
};

function task(status: string, wake?: string, note = "created"): string {
	return `---\nstatus: ${status}${wake ? `\nwake: ${wake}` : ""}\n---\n# Task\n\n## Current Cycle\n- ${note}\n`;
}

function governedTask(
	status: string,
	mutate: (control: ReturnType<typeof createDefaultTaskControl>) => void = () => {},
): string {
	const control = createDefaultTaskControl();
	mutate(control);
	return renderTaskDocument(
		{ status, control },
		"# Task\n\n## Current Cycle\n- created\n\n## Verification\n- check\n",
	);
}

describe("TaskDriver", () => {
	let workspaceDir: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-driver-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(channelId: string, id: string, content: string): Promise<void> {
		const dir = join(workspaceDir, channelId, "tasks");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, `${id}.md`), content);
	}

	it("discovers only DingTalk channel directories", async () => {
		await mkdir(join(workspaceDir, "dm_a"));
		await mkdir(join(workspaceDir, "events"));
		await expect(discoverTaskChannels(workspaceDir, ["group_b", "bad"])).resolves.toEqual(["dm_a", "group_b"]);
	});

	it("dispatches the first actionable task and leaves future/done tasks asleep", async () => {
		await writeTask("dm_a", "ready", task("in-progress"));
		await writeTask("dm_b", "later", task("blocked", "2026-07-10T18:00:00+08:00"));
		await writeTask("group_c", "done", task("done"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});

		await driver.runOnce(NOW);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ channelId: "dm_a", user: "TASK_DRIVER" });
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_DRIVER:ready]");
		expect(dispatch.mock.calls[0]?.[0].text).toContain("Task capsule: title=Task; status=in-progress;");
	});

	it("keeps dispatch behavior unchanged when the optional observer throws", async () => {
		await writeTask("dm_a", "ready", task("in-progress"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			onDispatch: () => {
				throw new Error("observer-only failure");
			},
			getSettings: () => SETTINGS,
		});

		await expect(driver.runOnce(NOW)).resolves.toBeUndefined();
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("skips active channels", async () => {
		await writeTask("dm_a", "ready", task("in-progress"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: (channelId) => channelId === "dm_a",
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("waits for dependencies without dispatching, then claims an attempt when ready", async () => {
		await writeTask("dm_a", "base", governedTask("in-progress"));
		await writeTask(
			"dm_a",
			"dependent",
			governedTask("in-progress", (control) => {
				control.priority = "critical";
				control.dependsOn = ["base"];
			}),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_DRIVER:base]");

		await writeTask("dm_a", "base", governedTask("done"));
		await driver.runOnce(new Date(NOW.getTime() + 5 * 60_000));
		expect(dispatch.mock.calls[1]?.[0].text).toContain("[TASK_DRIVER:dependent]");
		const dependent = await readFile(join(workspaceDir, "dm_a", "tasks", "dependent.md"), "utf-8");
		expect(dependent).toContain('"attempts":1');
	});

	it("escalates exhausted tasks instead of running them", async () => {
		await writeTask(
			"dm_a",
			"spent",
			governedTask("in-progress", (control) => {
				control.budget.maxAttempts = 2;
				control.usage.attempts = 2;
			}),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_ESCALATION:spent]");
		expect(dispatch.mock.calls[0]?.[0].text).toContain("attempt budget exhausted");
		const onDisk = await readFile(join(workspaceDir, "dm_a", "tasks", "spent.md"), "utf-8");
		expect(onDisk).toContain("status: escalated");
	});

	it("enforces a deadline even when wake would otherwise keep the task asleep", async () => {
		const content = governedTask("blocked", (control) => {
			control.deadline = "2026-07-10T03:00:00.000Z";
		}).replace("status: blocked", "status: blocked\nwake: 2026-07-11T00:00:00.000Z");
		await writeTask("dm_a", "late", content);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_ESCALATION:late]");
	});

	it("escalates a manually corrupted dependency cycle without spending a work attempt", async () => {
		await writeTask(
			"dm_a",
			"a",
			governedTask("open", (control) => {
				control.dependsOn = ["b"];
			}),
		);
		await writeTask(
			"dm_a",
			"b",
			governedTask("open", (control) => {
				control.dependsOn = ["a"];
			}),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("dependency cycle detected");
		const a = await readFile(join(workspaceDir, "dm_a", "tasks", "a.md"), "utf-8");
		expect(a).toContain("status: escalated");
		expect(a).toContain('"attempts":0');
	});

	it("backs off unchanged tasks but promptly continues after ledger progress", async () => {
		await writeTask("dm_a", "work", task("in-progress", undefined, "first"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		await driver.runOnce(new Date(NOW.getTime() + 10 * 60_000));
		expect(dispatch).toHaveBeenCalledTimes(1);

		await writeTask("dm_a", "work", task("in-progress", undefined, "second"));
		await driver.runOnce(new Date(NOW.getTime() + 11 * 60_000));
		expect(dispatch).toHaveBeenCalledTimes(2);
	});

	it("retries an unchanged task after the stalled interval", async () => {
		await writeTask("dm_a", "work", task("in-progress"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		await driver.runOnce(new Date(NOW.getTime() + 60 * 60_000));
		expect(dispatch).toHaveBeenCalledTimes(2);
	});

	it("does not mistake governed usage accounting for semantic task progress", async () => {
		await writeTask("dm_a", "work", governedTask("in-progress"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		await finishTaskAttempt(join(workspaceDir, "dm_a"), "work", {
			tokens: 100,
			costUsd: 0.1,
			wallTimeMinutes: 1,
			failed: false,
			finishedAt: new Date(NOW.getTime() + 1_000),
		});
		await driver.runOnce(new Date(NOW.getTime() + 10 * 60_000));
		expect(dispatch).toHaveBeenCalledTimes(1);
		await driver.runOnce(new Date(NOW.getTime() + 60 * 60_000));
		expect(dispatch).toHaveBeenCalledTimes(2);
	});

	it("caps each tick and round-robins later channels instead of starving them", async () => {
		await writeTask("dm_a", "a", task("in-progress"));
		await writeTask("dm_b", "b", task("in-progress"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => ({ ...SETTINGS, maxDispatchesPerTick: 1 }),
		});
		await driver.runOnce(NOW);
		await driver.runOnce(new Date(NOW.getTime() + 60_000));
		expect(dispatch.mock.calls.map(([event]) => event.channelId)).toEqual(["dm_a", "dm_b"]);
	});

	// Regression: within one channel, an actively-progressing task (fresh fingerprint every
	// tick, so it clears the short continuation delay every time) used to keep winning the
	// channel's single per-tick slot forever, starving every other ready task in that channel.
	it("round-robins between ready tasks within the same channel instead of letting one win every tick", async () => {
		await writeTask("dm_a", "x", task("in-progress", undefined, "note-1"));
		await writeTask("dm_a", "y", task("in-progress", undefined, "note-1"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});

		await driver.runOnce(NOW);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_DRIVER:x]");

		// "x" keeps producing new progress every tick, so it would clear the 5-minute
		// continuation delay and remain eligible on every subsequent scan.
		await writeTask("dm_a", "x", task("in-progress", undefined, "note-2"));
		await driver.runOnce(new Date(NOW.getTime() + 5 * 60_000));
		expect(dispatch.mock.calls[1]?.[0].text).toContain("[TASK_DRIVER:y]");

		await writeTask("dm_a", "x", task("in-progress", undefined, "note-3"));
		await driver.runOnce(new Date(NOW.getTime() + 10 * 60_000));
		expect(dispatch.mock.calls[2]?.[0].text).toContain("[TASK_DRIVER:x]");
	});

	it("does not dispatch when the tools.tasks master switch is off", async () => {
		await writeTask("dm_a", "ready", task("in-progress"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
			isEnabled: () => false,
		});
		await driver.runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("wakes a verification candidate with an explicit checker-only instruction", async () => {
		await writeTask("dm_a", "candidate", governedTask("verifying"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("checker-only turn");
		expect(dispatch.mock.calls[0]?.[0].text).toContain("task-driving.md");
	});

	it("scans on start, sleeps to the cap, and stops idempotently", async () => {
		vi.useFakeTimers();
		const runOnce = vi.spyOn(TaskDriver.prototype, "runOnce").mockResolvedValue(undefined);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch: () => true,
			getSettings: () => SETTINGS,
			intervalMs: 1000,
		});
		driver.start();
		driver.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(runOnce).toHaveBeenCalledTimes(1); // scan on start
		await vi.advanceTimersByTimeAsync(1000);
		expect(runOnce).toHaveBeenCalledTimes(2); // one capped sleep later
		driver.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(runOnce).toHaveBeenCalledTimes(2);
	});

	it("nudge cancels the pending sleep and rescans promptly", async () => {
		vi.useFakeTimers();
		const runOnce = vi.spyOn(TaskDriver.prototype, "runOnce").mockResolvedValue(undefined);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch: () => true,
			getSettings: () => SETTINGS,
			intervalMs: 60_000,
		});
		driver.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(runOnce).toHaveBeenCalledTimes(1);
		driver.nudge();
		driver.nudge(); // debounced: still one extra scan
		await vi.advanceTimersByTimeAsync(50);
		expect(runOnce).toHaveBeenCalledTimes(2);
		driver.stop();
	});

	it("opens a new cycle for a due recurring task without claiming an attempt", async () => {
		await writeTask(
			"dm_a",
			"weekly",
			governedTask("done", (control) => {
				control.usage.attempts = 3;
			}).replace("status: done", "status: done\nschedule: 30 9 * * 1\nwake: 2026-07-10T09:00:00+08:00"),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_CYCLE:weekly]");
		expect(dispatch.mock.calls[0]?.[0].text).toContain("start-cycle");
		// No attempt was claimed: usage on disk is unchanged.
		const onDisk = await readFile(join(workspaceDir, "dm_a", "tasks", "weekly.md"), "utf-8");
		expect(onDisk).toContain('"attempts":3');
	});

	it("does not open a cycle for a done recurring task whose wake is still in the future", async () => {
		await writeTask(
			"dm_a",
			"weekly",
			task("done").replace("status: done", "status: done\nschedule: 30 9 * * 1\nwake: 2026-07-20T09:30:00+08:00"),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("self-heals a missing wake for a done recurring task instead of waking the model", async () => {
		await writeTask("dm_a", "weekly", task("done").replace("status: done", "status: done\nschedule: 30 9 * * 1"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		const onDisk = await readFile(join(workspaceDir, "dm_a", "tasks", "weekly.md"), "utf-8");
		expect(onDisk).toMatch(/wake: 2026-07-\d\dT/);
	});

	it("runs the full native recurring loop: done → sleep → cycle-start → start-cycle → done", async () => {
		const channelDir = join(workspaceDir, "dm_a");
		const opts = { workspaceDir, channelDir, channelId: "dm_a" };
		await mkdir(join(channelDir, "tasks"), { recursive: true });
		await manageTask(opts, {
			action: "create",
			id: "weekly",
			title: "Weekly report",
			goal: "Publish weekly",
			dod: "- [x] published",
			schedule: "30 9 * * 1",
		});
		await manageTask(opts, { action: "done", id: "weekly", summary: "Done", evidence: "Checked" });
		// Recurring task stays in place, asleep until its next occurrence (computed off the schedule).
		const doneContent = await readFile(join(channelDir, "tasks", "weekly.md"), "utf-8");
		expect(doneContent).toContain("status: done");
		const wakeMs = new Date(/wake: (\S+)/.exec(doneContent)![1]).getTime();

		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});

		// Before the cadence fires: no wake.
		await driver.runOnce(new Date(wakeMs - 60_000));
		expect(dispatch).not.toHaveBeenCalled();

		// Just past the occurrence: driver opens a new cycle.
		await driver.runOnce(new Date(wakeMs + 60_000));
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_CYCLE:weekly]");

		// The agent turn opens the cycle and finishes it again.
		await manageTask(opts, { action: "start-cycle", id: "weekly", cycleId: "2026-W29" });
		const started = await readFile(join(channelDir, "tasks", "weekly.md"), "utf-8");
		expect(started).toContain("status: in-progress");
		expect(started).toContain('"cycleId":"2026-W29"');
		// Re-check the DoD and close cycle two.
		await manageTask(opts, {
			action: "progress",
			id: "weekly",
			note: "cycle two published",
			control: {},
		});
		const withDod = (await readFile(join(channelDir, "tasks", "weekly.md"), "utf-8")).replace(
			"- [ ] published",
			"- [x] published",
		);
		await writeFile(join(channelDir, "tasks", "weekly.md"), withDod);
		const done2 = await manageTask(opts, {
			action: "done",
			id: "weekly",
			summary: "Done again",
			evidence: "Checked",
		});
		expect(done2.archived).toBe(false);
		expect(await readFile(join(channelDir, "tasks", "weekly.md"), "utf-8")).toMatch(/wake: 2026-07-\d\dT/);
	});

	it("defers cycle-start to a live legacy .schedule event", async () => {
		await writeTask(
			"dm_a",
			"weekly",
			task("done").replace("status: done", "status: done\nschedule: 30 9 * * 1\nwake: 2026-07-10T09:00:00+08:00"),
		);
		const eventsDir = join(workspaceDir, "events");
		await mkdir(eventsDir, { recursive: true });
		await writeFile(
			join(eventsDir, "task.dm_a.weekly.schedule.json"),
			JSON.stringify({ type: "periodic", channelId: "dm_a", text: "推进任务 weekly", schedule: "30 9 * * 1" }),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
		});
		await driver.runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
