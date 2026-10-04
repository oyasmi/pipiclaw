import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTasksCommand, parseTasksCommand } from "../src/runtime/task-commands.js";
import { createUsage } from "../src/tasks/budget.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { appendTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { parkTask, readStoredTask } from "../src/tasks/store.js";

const FUTURE = "2099-01-01T00:00:00+08:00";
const PAST = "2020-01-01T00:00:00+08:00";
const BODY = renderStandardTaskBody({ title: "Weekly", goal: "Ship it.", dod: "- [ ] Shipped" });

describe("/tasks (spec 051, D11; spec 052, D11)", () => {
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

	async function writeTask(id: string, fields: Partial<TaskFrontmatter> = {}): Promise<void> {
		await writeFile(
			join(tasksDir, `${id}.md`),
			renderTaskDocument({ state: "open", usage: createUsage(), ...fields }, BODY),
		);
	}

	const run = (args: string, dispatchTask?: (id: string) => Promise<boolean>) =>
		handleTasksCommand({ args, channelDir, dispatchTask });

	it("pause/resume toggles only the paused marker, preserving the park", async () => {
		await writeTask("weekly", {
			state: "parked",
			ticket: { kind: "time", at: FUTURE, by: FUTURE },
		});

		await run("pause weekly");
		let fields = (await readStoredTask(channelDir, "weekly"))?.fields;
		expect(fields?.paused?.by).toBe("user");
		// Pausing is orthogonal: the stage and the ticket must survive it untouched.
		expect(fields?.state).toBe("parked");
		expect(fields?.ticket?.kind).toBe("time");

		await run("resume weekly");
		fields = (await readStoredTask(channelDir, "weekly"))?.fields;
		expect(fields?.paused).toBeUndefined();
		expect(fields?.state).toBe("parked");
	});

	// A budget grant must be headroom on top of what is already spent, or resuming a task that
	// hit its ceiling would simply re-stop on the very next scan.
	it("resume grants extra budget above what the task already used", async () => {
		await writeTask("spent", {
			budget: { steps: 5 },
			usage: { ...createUsage(), steps: 5 },
			paused: { by: "runtime", reason: "budget", at: PAST },
		});
		await expect(run("resume spent +steps 10")).resolves.toContain("steps+10");
		const fields = (await readStoredTask(channelDir, "spent"))?.fields;
		expect(fields?.paused).toBeUndefined();
		expect(fields?.budget?.steps).toBe(15);
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

	it("list shows the park, its backstop, work item progress and the spend", async () => {
		await writeTask("weekly", {
			state: "parked",
			ticket: { kind: "ask", asked: "merge?", by: FUTURE },
			usage: { ...createUsage(), steps: 4, usd: 1.5 },
			origin: "weekly-event",
		});
		const list = await run("");
		expect(list).toContain("等待中");
		expect(list).toContain("merge?");
		expect(list).toContain("4 步");
		expect(list).toContain("来自 weekly-event");
	});

	it("show renders the team board, the log and the contract instead of the whole file", async () => {
		await writeTask("weekly");
		await appendTaskLog(channelDir, "weekly", { kind: "dispatch", ref: "run_a", agent: "builder" });
		await appendTaskLog(channelDir, "weekly", { kind: "settle", ref: "run_a", status: "completed" });
		const shown = await run("show weekly");
		expect(shown).toContain("团队看板");
		expect(shown).toContain("run_a");
		expect(shown).toContain("/tasks log weekly");
	});

	it("log reads the whole loop log, dispatches and settlements included", async () => {
		await writeTask("weekly");
		await appendTaskLog(channelDir, "weekly", {
			kind: "step",
			seq: 1,
			outcome: "continue",
			note: "第一步",
			tools: [],
		});
		await appendTaskLog(channelDir, "weekly", { kind: "dispatch", ref: "run_a" });
		const log = await run("log weekly");
		expect(log).toContain("第一步");
		expect(log).toContain("run_a");
	});

	it("doctor only reports what a hand edit can still produce", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		await writeFile(
			join(tasksDir, "old.md"),
			'---\nstate: open\ncycle: {"id":"c-1"}\nschedule: 0 9 * * 1\n---\n# Old\n',
		);
		await writeTask("overdue", { state: "parked", ticket: { kind: "time", at: PAST, by: PAST } });
		await writeTask("clean");

		const report = await run("doctor");
		expect(report).toContain("broken 的 frontmatter 不可读");
		expect(report).toContain("old 仍含旧版本的字段");
		expect(report).toContain("overdue 的等待票已过兜底时限超过 1 小时");
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
		// `run` and the per-cycle `log` argument retired with cycles (spec 052).
		expect(() => parseTasksCommand("run x")).toThrow(/未知/);
		expect(() => parseTasksCommand("log x c-1")).toThrow(/用法/);
	});
});
