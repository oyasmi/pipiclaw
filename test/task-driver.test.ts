import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipiclawTaskDriverSettings } from "../src/config/settings.js";
import type { DingTalkEvent } from "../src/dingtalk/handler.js";
import { createTaskDriverEvent, TaskDriver, taskStopReceipt } from "../src/runtime/task-driver.js";
import { createUsage } from "../src/tasks/budget.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/contract.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { appendTaskLog, resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import { parkTask, readStoredTask } from "../src/tasks/store.js";

const NOW = new Date("2026-08-04T12:00:00+08:00");
const PAST = "2026-08-03T12:00:00+08:00";
const FUTURE = "2026-08-05T12:00:00+08:00";
const SETTINGS: PipiclawTaskDriverSettings = { maxDispatchesPerTick: 4, maxSleepMinutes: 15 };

function body(title = "Task"): string {
	return renderStandardTaskBody({ title, goal: "Do the work.", dod: "- [ ] Result is ready" });
}

function taskDoc(fields: TaskFrontmatter): string {
	return renderTaskDocument(fields, body());
}

describe("TaskDriver (spec 051, D9; spec 052)", () => {
	let workspaceDir: string;
	let dotDir: string;
	/** Channels bound to the dot; a task whose `channel` is not in here is suspended (spec 058, D8). */
	let bound: Set<string>;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-driver-v4-"));
		dotDir = join(workspaceDir, "news");
		bound = new Set(["dm_a"]);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	/** A task of the `news` dot delivering to `channelId` (its frontmatter `channel:`). */
	async function writeTask(channelId: string, id: string, content: string): Promise<string> {
		const dir = join(dotDir, "tasks");
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${id}.md`);
		await writeFile(path, content.replace(/^---\n/, `---\nchannel: ${channelId}\n`));
		return path;
	}

	function driver(
		dispatch: (event: DingTalkEvent) => boolean | Promise<boolean>,
		extra: Partial<ConstructorParameters<typeof TaskDriver>[0]> = {},
	): TaskDriver {
		return new TaskDriver({
			getActiveDots: () => [{ dot: "news", dotDir }],
			isBoundTo: (channelId, dot) => dot === "news" && bound.has(channelId),
			isChannelActive: () => false,
			dispatch,
			settings: SETTINGS,
			...extra,
		});
	}

	it("dispatches open work and never polls a pushed or future ticket", async () => {
		await writeTask("dm_a", "open", taskDoc({ state: "open" }));
		// A `work` ticket is redeemed by settlement, not by the scan: polling it would be the
		// unverified resumption path spec 051 removed.
		await writeTask(
			"dm_a",
			"awaiting-work",
			taskDoc({ state: "parked", ticket: { kind: "work", refs: ["run_x"], by: FUTURE } }),
		);
		await writeTask("dm_a", "later", taskDoc({ state: "parked", ticket: { kind: "time", at: FUTURE, by: FUTURE } }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(dispatch.mock.calls[0]?.[0].text).toContain("[TASK_DRIVER:open]");
	});

	it("delivers a step to the task's own channel, a base64 group id included", async () => {
		// Spec 058, D13: the delivery channel is read from the task, never derived from a path —
		// a group id with `/` and `=` must arrive intact, stamped with the task's dot.
		const channelId = "group_cidYDhGqxhJOzS7VDv/eDInUw==";
		bound.add(channelId);
		await writeTask(channelId, "open", taskDoc({ state: "open" }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			channelId,
			dot: "news",
			type: "group",
			conversationType: "2",
		});
	});

	it("never dispatches a paused task", async () => {
		await writeTask("dm_a", "held", taskDoc({ state: "open", paused: { by: "user", reason: "hold", at: PAST } }));
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("redeems a due time ticket and dispatches the reopened task — but only while its channel is bound", async () => {
		const path = await writeTask(
			"dm_a",
			"timed",
			taskDoc({ state: "parked", ticket: { kind: "time", at: PAST, by: PAST } }),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const instance = driver(dispatch);

		// Spec 058, D8: the delivery channel was rebound elsewhere. The task freezes whole — its
		// due ticket is neither redeemed nor expired, and no step or receipt goes anywhere.
		bound.delete("dm_a");
		await instance.runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		expect((await readStoredTask(dotDir, "timed"))?.fields.state).toBe("parked");

		// Bound again: it resumes from exactly where it froze.
		bound.add("dm_a");
		await instance.runOnce(NOW);
		expect(dispatch).toHaveBeenCalledOnce();
		expect((await readStoredTask(dotDir, "timed"))?.fields.state).toBe("open");
		expect(path).toContain("timed.md");
	});

	// D2-INV, the whole point of the ticket: a park that nothing redeems must not go silent.
	it("reopens an expired ticket, then stops the task and notifies on the second expiry", async () => {
		const parked = taskDoc({
			state: "parked",
			ticket: { kind: "work", refs: ["run_never"], by: PAST },
			usage: createUsage(NOW),
		});
		await writeTask("dm_a", "stuck", parked);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		const instance = driver(dispatch, { notify });

		await instance.runOnce(NOW);
		expect((await readStoredTask(dotDir, "stuck"))?.fields.state).toBe("open");
		expect(notify).not.toHaveBeenCalled();

		// Re-park on the same dead ticket, preserving the consecutive-expiry count.
		await parkTask(dotDir, "stuck", { kind: "work", refs: ["run_never"], by: PAST });
		await instance.runOnce(NOW);
		const fields = (await readStoredTask(dotDir, "stuck"))?.fields;
		expect(fields?.paused?.by).toBe("runtime");
		expect(notify).toHaveBeenCalledOnce();
		expect(notify.mock.calls[0]?.[0].text).toContain("/tasks resume stuck");
	});

	it("stops a task that is already over budget before spending a model call on it", async () => {
		await writeTask(
			"dm_a",
			"spent",
			taskDoc({ state: "open", budget: { steps: 2 }, usage: { ...createUsage(NOW), steps: 2 } }),
		);
		const dispatch = vi.fn((_event: DingTalkEvent) => true);
		const notify = vi.fn((_event: DingTalkEvent) => true);
		await driver(dispatch, { notify }).runOnce(NOW);
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect((await readStoredTask(dotDir, "spent"))?.fields.paused?.by).toBe("runtime");
	});

	it("stops a loop whose last two steps called no tool at all", async () => {
		await writeTask("dm_a", "idle", taskDoc({ state: "open", usage: { ...createUsage(NOW), steps: 2 } }));
		for (const seq of [1, 2]) {
			await appendTaskLog(dotDir, "idle", {
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
		expect((await readStoredTask(dotDir, "idle"))?.fields.paused?.reason).toContain("没有任何工具调用");
	});

	it("keeps driving a loop whose steps actually used tools", async () => {
		await writeTask("dm_a", "busy", taskDoc({ state: "open", usage: { ...createUsage(NOW), steps: 2 } }));
		for (const seq of [1, 2]) {
			await appendTaskLog(dotDir, "busy", {
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
			fields: { state: "open" as const, usage: createUsage(NOW) },
			readable: true,
			legacy: false,
			runnable: true,
			expired: false,
		};
		const step = createTaskDriverEvent("news", "dm_a", entry, NOW.getTime());
		expect(step.text).toContain("[TASK_DRIVER:T]");
		expect(step.text).toContain("task_step_end");

		// An unreadable file must never be driven as ordinary work: a repair dispatch is
		// explicitly forbidden from executing the goal.
		const repair = createTaskDriverEvent("news", "dm_a", { ...entry, readable: false }, NOW.getTime());
		expect(repair.text).toContain("Do not execute the task goal");

		const receipt = taskStopReceipt("news", "dm_a", entry, "预算耗尽", NOW.getTime());
		expect(receipt.text).toContain("预算耗尽");
		expect(receipt.text).toContain("/tasks show T");
		expect(Number(receipt.ts)).toBe(NOW.getTime());
	});
});
