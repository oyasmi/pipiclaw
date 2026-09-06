import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTasksCommand, parseTasksCommand } from "../src/runtime/task-commands.js";
import { createCycle } from "../src/tasks/cycle.js";
import type { TaskFrontmatterV4 } from "../src/tasks/frontmatter.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { appendTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { parkTask, readStoredTask } from "../src/tasks/store.js";

const FUTURE = "2099-01-01T00:00:00+08:00";
const PAST = "2020-01-01T00:00:00+08:00";
const BODY = renderStandardTaskBody({ title: "Weekly", goal: "Ship it.", dod: "- [ ] Shipped" });

describe("/tasks (spec 051, D11)", () => {
	let workspaceDir: string;
	let channelDir: string;
	let tasksDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-commands-v4-"));
		channelDir = join(workspaceDir, "dm_1");
		tasksDir = join(channelDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
	});
	afterEach(async () => {
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, fields: Partial<TaskFrontmatterV4> = {}): Promise<void> {
		await writeFile(
			join(tasksDir, `${id}.md`),
			renderTaskDocument({ state: "open", cycle: createCycle("c-1"), ...fields }, BODY),
		);
	}

	const run = (args: string, dispatchTask?: (id: string) => Promise<boolean>) =>
		handleTasksCommand({ args, channelDir, workspaceDir, channelId: "dm_1", dispatchTask });

	it("pause/resume toggles only the paused marker, preserving the park", async () => {
		await writeTask("weekly", {
			state: "parked",
			schedule: "0 9 * * 1",
			ticket: { kind: "time", at: FUTURE, by: FUTURE },
		});

		await expect(run("pause weekly")).resolves.toContain("已暂停任务");
		let fields = (await readStoredTask(channelDir, "weekly"))?.fields;
		expect(fields?.paused?.by).toBe("user");
		// Pausing is orthogonal: the stage and the ticket must survive it untouched.
		expect(fields?.state).toBe("parked");
		expect(fields?.ticket?.kind).toBe("time");

		await expect(run("resume weekly")).resolves.toContain("已恢复任务");
		fields = (await readStoredTask(channelDir, "weekly"))?.fields;
		expect(fields?.paused).toBeUndefined();
		expect(fields?.state).toBe("parked");
	});

	// A budget grant must be headroom on top of what is already spent, or resuming a task that
	// hit its ceiling would simply re-stop on the very next scan.
	it("resume grants extra budget above what this cycle already used", async () => {
		await writeTask("spent", {
			budget: { steps: 5 },
			cycle: { ...createCycle("c-1"), steps: 5 },
			paused: { by: "runtime", reason: "budget", at: PAST },
		});
		await expect(run("resume spent +steps 10")).resolves.toContain("steps+10");
		const fields = (await readStoredTask(channelDir, "spent"))?.fields;
		expect(fields?.paused).toBeUndefined();
		expect(fields?.budget?.steps).toBe(15);
	});

	it("run opens a cycle for a parked task and dispatches it immediately", async () => {
		await writeTask("weekly", { state: "parked", ticket: { kind: "time", at: FUTURE, by: FUTURE } });
		const dispatchTask = vi.fn(async () => true);
		await expect(run("run weekly", dispatchTask)).resolves.toContain("已立即唤醒任务");
		expect(dispatchTask).toHaveBeenCalledWith("weekly");
		const fields = (await readStoredTask(channelDir, "weekly"))?.fields;
		expect(fields?.state).toBe("open");
		expect(fields?.ticket).toBeUndefined();
	});

	it("run refuses a paused task and points at resume", async () => {
		await writeTask("held", { paused: { by: "user", reason: "hold", at: PAST } });
		const dispatchTask = vi.fn(async () => true);
		await expect(run("run held", dispatchTask)).resolves.toContain("/tasks resume held");
		expect(dispatchTask).not.toHaveBeenCalled();
	});

	it("steer queues guidance for the next step without changing task state", async () => {
		await writeTask("weekly");
		await expect(run("steer weekly 先跑一遍 npm run check")).resolves.toContain("下一步");
		expect(await readFile(join(tasksDir, ".steer", "weekly.md"), "utf-8")).toContain("npm run check");
		expect((await readStoredTask(channelDir, "weekly"))?.fields.state).toBe("open");
	});

	it("reply redeems an ask ticket, and still keeps the words when the task was not asking", async () => {
		await writeTask("asked");
		await parkTask(channelDir, "asked", { kind: "ask", asked: "merge?", by: FUTURE });
		const dispatchTask = vi.fn(async () => true);
		await expect(run("reply asked 合并吧", dispatchTask)).resolves.toContain("会继续推进");
		expect((await readStoredTask(channelDir, "asked"))?.fields.state).toBe("open");
		expect(dispatchTask).toHaveBeenCalledWith("asked");

		await writeTask("busy");
		await expect(run("reply busy 顺便看看这个")).resolves.toContain("并没有在等你的回答");
		// The user's words are never dropped just because the timing was off.
		expect(await readFile(join(tasksDir, ".steer", "busy.md"), "utf-8")).toContain("顺便看看这个");
	});

	it("list shows the park, its backstop and this cycle's spend", async () => {
		await writeTask("weekly", {
			state: "parked",
			ticket: { kind: "ask", asked: "merge?", by: FUTURE },
			cycle: { ...createCycle("c-1"), steps: 4, rounds: 2, usd: 1.5 },
		});
		const list = await run("");
		expect(list).toContain("等待中");
		expect(list).toContain("merge?");
		expect(list).toContain("4 步 / 2 轮");
	});

	it("show renders contract, log and rework rounds instead of the whole file", async () => {
		await writeTask("weekly", { verify: "required" });
		await appendTaskLog(channelDir, "weekly", {
			cycle: "c-1",
			kind: "round",
			n: 1,
			verifyRunId: "run_v",
			verdict: "fail",
			strength: "advisory",
		});
		const shown = await run("show weekly");
		expect(shown).toContain("需要独立验收");
		expect(shown).toContain("返工：1 轮");
		expect(shown).toContain("/tasks log weekly");
	});

	it("log reads the loop log, including per-cycle filtering", async () => {
		await writeTask("weekly");
		await appendTaskLog(channelDir, "weekly", {
			cycle: "c-1",
			kind: "step",
			seq: 1,
			outcome: "continue",
			note: "第一步",
			tools: [],
		});
		await appendTaskLog(channelDir, "weekly", {
			cycle: "c-2",
			kind: "step",
			seq: 1,
			outcome: "continue",
			note: "第二周期",
			tools: [],
		});
		expect(await run("log weekly")).toContain("第一步");
		const scoped = await run("log weekly c-2");
		expect(scoped).toContain("第二周期");
		expect(scoped).not.toContain("第一步");
	});

	it("doctor only reports what a hand edit can still produce", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		await writeFile(
			join(tasksDir, "old.md"),
			'---\nstatus: active\nenabled: true\ncontrol: {"version":3}\n---\n# Old\n',
		);
		await writeTask("overdue", { state: "parked", ticket: { kind: "time", at: PAST, by: PAST } });
		await writeTask("clean");

		const report = await run("doctor");
		expect(report).toContain("broken 的 frontmatter 不可读");
		expect(report).toContain("old 仍是 v3 契约");
		expect(report).toContain("overdue 的等待票已过兜底时限");
		// A healthy task produces no line at all: doctor is a diagnosis, not an inventory.
		expect(report).not.toContain("clean");
	});

	it("shows archive outcome and rejects path traversal", async () => {
		await writeFile(
			join(tasksDir, "archive", "old.md"),
			renderTaskDocument({ state: "done", outcome: "completed", closedAt: PAST }, BODY),
		);
		expect(await run("archive")).toContain("old");
		await expect(run("show ../../secret")).resolves.toMatch(/Invalid task id|失败/);
		expect(existsSync(join(tasksDir, "..", "..", "secret.md"))).toBe(false);
	});

	it("rejects a retired action without writing anything", async () => {
		await writeTask("weekly");
		const before = await readFile(join(tasksDir, "weekly.md"), "utf-8");
		const unknown = await run("approve weekly");
		expect(unknown).toContain("未知的 /tasks 动作：approve");
		expect(await readFile(join(tasksDir, "weekly.md"), "utf-8")).toBe(before);
	});

	it("parses every documented argument shape", () => {
		expect(parseTasksCommand("")).toEqual({ action: "list" });
		expect(parseTasksCommand("resume x +steps 20 +usd 5")).toEqual({
			action: "resume",
			id: "x",
			grants: { steps: 20, usd: 5 },
		});
		expect(parseTasksCommand("steer x 多行 内容 都要保留")).toMatchObject({ text: "多行 内容 都要保留" });
		expect(() => parseTasksCommand("steer x")).toThrow(/用法/);
	});
});
