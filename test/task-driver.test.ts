import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChannelDir } from "../src/channel/channel-paths.js";
import type { DingTalkEvent } from "../src/runtime/dingtalk.js";
import { createTaskDriverEvent, TaskDriver, taskStopReceipt } from "../src/runtime/task-driver.js";
import type { PipiclawTaskDriverSettings } from "../src/settings.js";
import { formatLocalTime } from "../src/shared/local-time.js";
import { createCycle } from "../src/tasks/cycle.js";
import type { TaskFrontmatterV4 } from "../src/tasks/frontmatter.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { appendTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { parkTask, readStoredTask } from "../src/tasks/store.js";

const NOW = new Date("2026-08-04T12:00:00+08:00");
const PAST = "2026-08-03T12:00:00+08:00";
const FUTURE = "2026-08-05T12:00:00+08:00";
const SETTINGS: PipiclawTaskDriverSettings = { maxDispatchesPerTick: 4, maxSleepMinutes: 15 };

function body(title = "Task"): string {
	return renderStandardTaskBody({ title, goal: "Do the work.", dod: "- [ ] Result is ready" });
}

function taskDoc(fields: TaskFrontmatterV4): string {
	return renderTaskDocument(fields, body());
}

describe("TaskDriver (spec 051, D9)", () => {
	let workspaceDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-driver-v4-"));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(channelId: string, id: string, content: string): Promise<string> {
		// Escape exactly as production does: a DingTalk group id is base64 and routinely
		// contains `/`, which only lives on disk as `__`.
		const dir = join(getChannelDir(workspaceDir, channelId), "tasks");
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

	it("dispatches open work and never polls a pushed or future ticket", async () => {
		await writeTask("dm_a", "open", taskDoc({ state: "open" }));
		// A `run` ticket is redeemed by settlement, not by the scan: polling it would be the
		// unverified resumption path spec 051 removed.
		await writeTask(
			"dm_a",
			"awaiting-run",
			taskDoc({ state: "parked", ticket: { kind: "run", id: "run_x", by: FUTURE } }),
		);
		await writeTask("dm_a", "later", taskDoc({ state: "parked", ticket: { kind: "time", at: FUTURE, by: FUTURE } }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_DRIVER:open]");
	});

	it("finds tasks for a group channel whose id contains a slash", async () => {
		// Regression: the driver used to join the raw id onto the workspace path, so a base64
		// conversation id resolved to a nested directory that never exists. Every such channel
		// read as "no active tasks" — no dispatch, no receipt, no log line.
		const channelId = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
		await writeTask(channelId, "open", taskDoc({ state: "open" }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("never dispatches a paused task", async () => {
		await writeTask("dm_a", "held", taskDoc({ state: "open", paused: { by: "user", reason: "hold", at: PAST } }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("redeems a due time ticket and dispatches the reopened task in the same tick", async () => {
		const path = await writeTask(
			"dm_a",
			"timed",
			taskDoc({ state: "parked", ticket: { kind: "time", at: PAST, by: PAST } }),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		expect((await readStoredTask(join(workspaceDir, "dm_a"), "timed"))?.fields.state).toBe("open");
		expect(path).toContain("timed.md");
	});

	it("opens the next cycle for a due schedule ticket without spending a model turn on it", async () => {
		await writeTask(
			"dm_a",
			"daily",
			taskDoc({
				state: "parked",
				schedule: "0 9 * * *",
				ticket: { kind: "schedule", at: PAST, by: PAST },
				cycle: { ...createCycle("c-2026-08-03"), steps: 7 },
			}),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		const fields = (await readStoredTask(join(workspaceDir, "dm_a"), "daily"))?.fields;
		expect(fields?.state).toBe("open");
		// Fresh counters: the new occurrence must not inherit the last one's spent budget.
		expect(fields?.cycle).toMatchObject({ id: "c-2026-08-04", steps: 0 });
		expect(dispatch).toHaveBeenCalledOnce();
	});

	// D2-INV, the whole point of the ticket: a park that nothing redeems must not go silent.
	it("reopens an expired ticket, then stops the task and notifies on the second expiry", async () => {
		const channelDir = join(workspaceDir, "dm_a");
		const parked = taskDoc({
			state: "parked",
			ticket: { kind: "run", id: "run_never", by: PAST },
			cycle: createCycle("c-2026-08-04"),
		});
		await writeTask("dm_a", "stuck", parked);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		const instance = driver(dispatch, { notify });

		await instance.runOnce(NOW);
		expect((await readStoredTask(channelDir, "stuck"))?.fields.state).toBe("open");
		expect(notify).not.toHaveBeenCalled();

		// Re-park on the same dead ticket, preserving the cycle's expiry count.
		await parkTask(channelDir, "stuck", { kind: "run", id: "run_never", by: PAST });
		await instance.runOnce(NOW);
		const fields = (await readStoredTask(channelDir, "stuck"))?.fields;
		expect(fields?.paused?.by).toBe("runtime");
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0].text).toContain("/tasks resume stuck");
	});

	it("stops a task that is already over budget before spending a model call on it", async () => {
		await writeTask(
			"dm_a",
			"spent",
			taskDoc({ state: "open", budget: { steps: 2 }, cycle: { ...createCycle("c-2026-08-04"), steps: 2 } }),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch, { notify }).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect((await readStoredTask(join(workspaceDir, "dm_a"), "spent"))?.fields.paused?.by).toBe("runtime");
	});

	it("stops a loop whose last two steps called no tool at all", async () => {
		const channelDir = join(workspaceDir, "dm_a");
		await writeTask("dm_a", "idle", taskDoc({ state: "open", cycle: { ...createCycle("c-1"), steps: 2 } }));
		for (const seq of [1, 2]) {
			await appendTaskLog(channelDir, "idle", {
				cycle: "c-1",
				kind: "step",
				seq,
				outcome: "continue",
				note: "thinking",
				tools: [],
			});
		}
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch, { notify }).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		expect((await readStoredTask(channelDir, "idle"))?.fields.paused?.reason).toContain("没有任何工具调用");
	});

	it("keeps driving a loop whose steps actually used tools", async () => {
		const channelDir = join(workspaceDir, "dm_a");
		await writeTask("dm_a", "busy", taskDoc({ state: "open", cycle: { ...createCycle("c-1"), steps: 2 } }));
		for (const seq of [1, 2]) {
			await appendTaskLog(channelDir, "busy", {
				cycle: "c-1",
				kind: "step",
				seq,
				outcome: "continue",
				note: "worked",
				tools: ["bash"],
			});
		}
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("does not queue a second step for a task it just dispatched", async () => {
		await writeTask("dm_a", "open", taskDoc({ state: "open" }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const instance = driver(dispatch);
		await instance.runOnce(NOW);
		await instance.runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
	});

	it("renders a step dispatch, a repair-only dispatch, and a stop receipt", async () => {
		const entry = {
			id: "T",
			title: "Title",
			fields: { state: "open" as const, cycle: createCycle("c-1") },
			readable: true,
			legacy: false,
			runnable: true,
			expired: false,
		};
		const step = createTaskDriverEvent("dm_a", entry, NOW.getTime());
		expect(step.text).toContain("[TASK_DRIVER:T]");
		expect(step.text).toContain("task_step_end");

		// A legacy or unreadable file must never be driven as ordinary work: a repair dispatch is
		// explicitly forbidden from executing the goal.
		const repair = createTaskDriverEvent("dm_a", { ...entry, legacy: true }, NOW.getTime());
		expect(repair.text).toContain("Do not execute the task goal");

		const receipt = taskStopReceipt("dm_a", entry, "预算耗尽", NOW.getTime());
		expect(receipt.text).toContain("预算耗尽");
		expect(receipt.text).toContain("/tasks show T");
		expect(formatLocalTime(new Date(Number(receipt.ts)))).toBeTruthy();
	});
});
