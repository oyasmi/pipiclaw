import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import {
	createTaskDriverEvent,
	createTaskVerificationEvent,
	discoverTaskChannels,
	TaskDriver,
	taskGovernorReceipt,
} from "../src/runtime/task-driver.js";
import type { PipiclawTaskDriverSettings } from "../src/settings.js";
import { formatLocalTime } from "../src/shared/local-time.js";
import { nextTaskWake } from "../src/shared/task-schedule.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";

const NOW = new Date("2026-08-04T12:00:00+08:00");
const SETTINGS: PipiclawTaskDriverSettings = {
	continuationDelayMinutes: 5,
	stalledRetryMinutes: 60,
	maxDispatchesPerTick: 4,
	maxSleepMinutes: 15,
};

function body(title = "Task"): string {
	return renderStandardTaskBody({ title, goal: "Do the work.", dod: "- [ ] Result is ready" });
}

function taskDoc(
	status: "active" | "waiting" | "sleeping",
	options: {
		wake?: string;
		schedule?: string;
		enabled?: boolean;
		control?: ReturnType<typeof createDefaultTaskControl>;
	} = {},
): string {
	return renderTaskDocument(
		{
			status,
			wake: options.wake,
			schedule: options.schedule,
			enabled: options.enabled,
			control: options.control,
		},
		body(),
	);
}

describe("TaskDriver v2", () => {
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-driver-v2-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(channelId: string, id: string, content: string): Promise<string> {
		const dir = join(workspaceDir, channelId, "tasks");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${id}.md`);
		await writeFile(path, content);
		return path;
	}

	function driver(
		dispatch: (event: DingTalkEvent) => boolean | Promise<boolean>,
		extra: Partial<ConstructorParameters<typeof TaskDriver>[0]> = {},
	): TaskDriver {
		return new TaskDriver({
			workspaceDir,
			isChannelActive: () => false,
			dispatch,
			getSettings: () => SETTINGS,
			...extra,
		});
	}

	it("discovers only valid channel directories", async () => {
		await mkdir(join(workspaceDir, "dm_a"));
		await mkdir(join(workspaceDir, "events"));
		expect(await discoverTaskChannels(workspaceDir, ["group_b", "bad"])).toEqual(["dm_a", "group_b"]);
	});

	it("dispatches active work but never polls parked waiting or future sleeping", async () => {
		await writeTask("dm_a", "active", taskDoc("active"));
		await writeTask("dm_a", "parked", taskDoc("waiting"));
		await writeTask(
			"dm_a",
			"later",
			taskDoc("sleeping", { schedule: "0 9 * * *", wake: "2026-08-05T09:00:00+08:00" }),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_DRIVER:active]");
	});

	it("honors enabled as an independent kill switch for every live stage", async () => {
		await writeTask("dm_a", "active", taskDoc("active", { enabled: false }));
		await writeTask("dm_a", "waiting", taskDoc("waiting", { enabled: false, wake: "2020-01-01T00:00:00+08:00" }));
		await writeTask(
			"dm_a",
			"sleeping",
			taskDoc("sleeping", { enabled: false, schedule: "0 9 * * *", wake: "2020-01-01T00:00:00+08:00" }),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("atomically activates a due timed wait before dispatch", async () => {
		const control = createDefaultTaskControl();
		const path = await writeTask("dm_a", "timed", taskDoc("waiting", { wake: "2026-08-04T09:00:00+08:00", control }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch.mock.calls[0]?.[0].text).toContain("status=active");
		const after = await readFile(path, "utf-8");
		expect(after).toContain("status: active");
		expect(after).not.toContain("wake:");
	});

	it("self-heals a missing sleeping wake with zero dispatch", async () => {
		const path = await writeTask("dm_a", "heal", taskDoc("sleeping", { schedule: "0 9 * * *" }));
		const rendered = await readFile(path, "utf-8");
		await writeFile(path, rendered.replace(/^wake: .*\n/m, ""));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		const after = await readFile(path, "utf-8");
		expect(after).toContain("status: sleeping");
		expect(after).toContain(`wake: ${formatLocalTime(nextTaskWake("0 9 * * *", NOW)!)}`);
	});

	it("stops a sleeping task with a bad schedule and sends a deterministic receipt", async () => {
		const control = createDefaultTaskControl();
		const path = await writeTask("dm_a", "bad-schedule", taskDoc("sleeping", { schedule: "not cron", control }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch, { notify }).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0].text).toContain("invalid schedule");
		const after = await readFile(path, "utf-8");
		expect(after).toContain("enabled: false");
		expect(after).toContain('"by":"governor"');
	});

	it("repairs an invalid sleeping schedule even while the channel is busy", async () => {
		const control = createDefaultTaskControl();
		const path = await writeTask("dm_a", "busy-bad-schedule", taskDoc("sleeping", { schedule: "not cron", control }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch, { notify, isChannelActive: () => true }).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect(await readFile(path, "utf-8")).toContain("enabled: false");
	});

	it("opens the first recurring cycle through the same runtime path and keeps placeholder history out", async () => {
		const path = await writeTask(
			"dm_a",
			"weekly",
			taskDoc("sleeping", {
				schedule: "0 9 * * *",
				wake: "2026-08-04T09:00:00+08:00",
				control: createDefaultTaskControl(),
			}),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		const after = await readFile(path, "utf-8");
		expect(after).toContain("status: active");
		expect(after).toContain('"cycleId":"cycle-2026-08-04"');
		expect(after).not.toContain("### Current Cycle — closed");
		expect(dispatch.mock.calls[0]?.[0].dispatchId).toContain("cycle-2026-08-04");
	});

	it("does not open a concurrent recurring cycle when the current one missed the next occurrence", async () => {
		const control = createDefaultTaskControl();
		control.cycleId = "cycle-2026-08-03";
		const path = await writeTask("dm_a", "missed", taskDoc("active", { schedule: "0 9 * * *", control }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(await readFile(path, "utf-8")).toContain("status: active");
		expect(await readFile(path, "utf-8")).not.toContain('"cycleId":"cycle-2026-08-04"');
	});

	it("governs budget exhaustion without changing active into a terminal state", async () => {
		const control = createDefaultTaskControl();
		control.budget.maxAttempts = 2;
		control.usage.attempts = 2;
		const path = await writeTask("dm_a", "spent", taskDoc("active", { control }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch, { notify }).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify.mock.calls[0]?.[0].text).toContain("attempt budget exhausted");
		const after = await readFile(path, "utf-8");
		expect(after).toContain("status: active");
		expect(after).toContain("enabled: false");
	});

	it("disables after three accepted active wakes with no visible effect", async () => {
		const control = createDefaultTaskControl();
		const path = await writeTask("dm_a", "spinning", taskDoc("active", { control }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		const taskDriver = driver(dispatch, { notify });
		await taskDriver.runOnce(NOW);
		await taskDriver.runOnce(new Date(NOW.getTime() + 60 * 60_000));
		await taskDriver.runOnce(new Date(NOW.getTime() + 120 * 60_000));
		await taskDriver.runOnce(new Date(NOW.getTime() + 180 * 60_000));
		expect(dispatch).toHaveBeenCalledTimes(3);
		expect(notify).toHaveBeenCalledOnce();
		const after = await readFile(path, "utf-8");
		expect(after).toContain("status: active");
		expect(after).toContain("enabled: false");
		expect(after).toContain('"by":"governor"');
	});

	it("does not count model-written nextAction or blockedReason as progress", async () => {
		const control = createDefaultTaskControl();
		const path = await writeTask("dm_a", "model-churn", taskDoc("active", { control }));
		let dispatchCount = 0;
		const dispatch = vi.fn(async (_event: DingTalkEvent) => {
			dispatchCount++;
			const stored = await readFile(path, "utf-8");
			const controlLine = stored.match(/^control: (.+)$/m);
			if (!controlLine?.[1]) throw new Error("test task control missing");
			const nextControl = JSON.parse(controlLine[1]) as ReturnType<typeof createDefaultTaskControl>;
			nextControl.nextAction = `model note ${dispatchCount}`;
			nextControl.blockedReason = `model explanation ${dispatchCount}`;
			await writeFile(path, stored.replace(/^control: .+$/m, `control: ${JSON.stringify(nextControl)}`));
			return true;
		});
		const notify = vi.fn((_event: DingTalkEvent) => true);
		const taskDriver = driver(dispatch, { notify });
		await taskDriver.runOnce(NOW);
		await taskDriver.runOnce(new Date(NOW.getTime() + 60 * 60_000));
		await taskDriver.runOnce(new Date(NOW.getTime() + 120 * 60_000));
		await taskDriver.runOnce(new Date(NOW.getTime() + 180 * 60_000));
		expect(dispatch).toHaveBeenCalledTimes(3);
		expect(notify).toHaveBeenCalledOnce();
		expect(await readFile(path, "utf-8")).toContain("enabled: false");
	});
});

describe("task driver events", () => {
	it("contains no retired approval or verifier lifecycle status", () => {
		const entry = {
			id: "task-1",
			title: "Task",
			frontmatter: { readable: true, enabled: true, status: "active", control: createDefaultTaskControl() },
			actionable: true,
		};
		const event = createTaskDriverEvent("dm_1", entry, NOW.getTime(), 2);
		expect(event.text).toContain("[TASK_DRIVER:task-1]");
		expect(event.text).not.toMatch(/approval|verifying|sideEffects|externalApproval/i);
		expect(event.taskAttemptGeneration).toBe(2);
		const verification = createTaskVerificationEvent("dm_1", entry, NOW.getTime());
		expect(verification.text).toContain("purpose=verify");
		expect(verification.text).toContain("task_manage verify");
		const repair = createTaskDriverEvent(
			"dm_1",
			{ id: "broken", title: "Broken", frontmatter: { readable: false, enabled: true }, actionable: true },
			NOW.getTime(),
		);
		expect(repair.text).toContain("repair only");
		expect(repair.text).toContain("Do not execute the task goal");
	});

	it("uses deterministic governor receipt content", () => {
		const entry = {
			id: "task-1",
			title: "Task",
			frontmatter: { readable: true, enabled: false, status: "active", control: createDefaultTaskControl() },
			actionable: false,
		};
		const first = taskGovernorReceipt("dm_1", entry, "attempt budget exhausted", NOW.getTime());
		const second = taskGovernorReceipt("dm_1", entry, "attempt budget exhausted", NOW.getTime() + 1000);
		expect(first.text).toContain("/tasks resume task-1");
		expect(first.dispatchId).toBe(second.dispatchId);
	});
});
