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

const NOW = new Date("2026-07-10T12:00:00+08:00");
const SETTINGS: PipiclawTaskDriverSettings = {
	enabled: true,
	continuationDelayMinutes: 5,
	stalledRetryMinutes: 60,
	maxDispatchesPerTick: 4,
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

	it("lets a live legacy checkin own the handoff, then recovers it when stale", async () => {
		await writeTask("dm_a", "ready", task("awaiting-user", "2026-07-10T11:59:00+08:00"));
		await mkdir(join(workspaceDir, "events"), { recursive: true });
		await writeFile(
			join(workspaceDir, "events", "task.dm_a.ready.checkin.json"),
			JSON.stringify({
				type: "one-shot",
				channelId: "dm_a",
				text: "legacy",
				at: "2026-07-10T11:59:00+08:00",
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
		expect(dispatch).not.toHaveBeenCalled();
		await driver.runOnce(new Date(NOW.getTime() + 2 * 60_000 + 1));
		expect(dispatch).toHaveBeenCalledOnce();
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

	it("does not dispatch when disabled", async () => {
		await writeTask("dm_a", "ready", task("in-progress"));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const driver = new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => ({ ...SETTINGS, enabled: false }),
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
		expect(dispatch.mock.calls[0]?.[0].text).toContain("purpose=verify");
	});

	it("starts and stops an idempotent scan timer", async () => {
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
		await vi.advanceTimersByTimeAsync(1000);
		expect(runOnce).toHaveBeenCalledTimes(1);
		driver.stop();
		await vi.advanceTimersByTimeAsync(1000);
		expect(runOnce).toHaveBeenCalledTimes(1);
	});
});
