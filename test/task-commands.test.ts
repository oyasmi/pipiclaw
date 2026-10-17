import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsage } from "../src/tasks/budget.js";
import { handleTasksCommand, parseTasksCommand } from "../src/tasks/commands.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/contract.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import { parkTask, readStoredTask } from "../src/tasks/store.js";

const FUTURE = "2099-01-01T00:00:00+08:00";
const PAST = "2020-01-01T00:00:00+08:00";
const BODY = renderStandardTaskBody({ title: "Weekly", goal: "Ship it.", dod: "- [ ] Shipped" });

describe("/tasks (spec 051, D11; spec 052, D11)", () => {
	let workspaceDir: string;
	let dotDir: string;
	let tasksDir: string;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-commands-v4-"));
		dotDir = join(workspaceDir, "dm_1");
		tasksDir = join(dotDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
	});
	afterEach(async () => {
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, fields: Partial<TaskFrontmatter> = {}): Promise<void> {
		await writeFile(
			join(tasksDir, `${id}.md`),
			renderTaskDocument({ state: "open", channel: "dm_1", usage: createUsage(), ...fields }, BODY),
		);
	}

	const run = (args: string, dispatchTask?: (id: string) => Promise<boolean>) =>
		handleTasksCommand({
			args,
			dotDir,
			currentChannelId: "dm_1",
			describeChannel: (channelId) => ({ label: `\`${channelId}\``, boundHere: true }),
			dispatchTask,
		});

	it("pause/resume toggles only the paused marker, preserving the park", async () => {
		await writeTask("weekly", {
			state: "parked",
			ticket: { kind: "time", at: FUTURE, by: FUTURE },
		});

		await run("pause weekly");
		let fields = (await readStoredTask(dotDir, "weekly"))?.fields;
		expect(fields?.paused?.by).toBe("user");
		// Pausing is orthogonal: the stage and the ticket must survive it untouched.
		expect(fields?.state).toBe("parked");
		expect(fields?.ticket?.kind).toBe("time");

		await run("resume weekly");
		fields = (await readStoredTask(dotDir, "weekly"))?.fields;
		expect(fields?.paused).toBeUndefined();
		// Resuming a user pause keeps the live ticket: the task goes back to waiting, not to open.
		expect(fields?.state).toBe("parked");
		expect(fields?.ticket).toEqual({ kind: "time", at: FUTURE, by: FUTURE });
	});

	// A budget grant must be headroom on top of what is already spent, or resuming a task that
	// hit its ceiling would simply re-stop on the very next scan.
	it("resume grants extra budget above what the task already used", async () => {
		await writeTask("spent", {
			budget: { steps: 5 },
			usage: { ...createUsage(), steps: 5 },
			paused: { by: "runtime", reason: "budget", at: PAST },
		});
		await run("resume spent +steps 10");
		const fields = (await readStoredTask(dotDir, "spent"))?.fields;
		expect(fields?.paused).toBeUndefined();
		expect(fields?.budget?.steps).toBe(15);
	});

	it("steer queues guidance for the next step without changing task state", async () => {
		await writeTask("weekly");
		await run("steer weekly 先跑一遍 npm run check");
		expect(await readFile(join(tasksDir, ".steer", "weekly.md"), "utf-8")).toContain("npm run check");
		expect((await readStoredTask(dotDir, "weekly"))?.fields.state).toBe("open");
	});

	it("reply redeems an ask ticket, and still keeps the words when the task was not asking", async () => {
		await writeTask("asked");
		await parkTask(dotDir, "asked", { kind: "ask", asked: "merge?", by: FUTURE });
		const dispatchTask = vi.fn(async () => true);
		await run("reply asked 合并吧", dispatchTask);
		expect((await readStoredTask(dotDir, "asked"))?.fields.state).toBe("open");
		expect(dispatchTask).toHaveBeenCalledWith("asked");

		await writeTask("busy");
		await run("reply busy 顺便看看这个");
		// The user's words are never dropped just because the timing was off.
		expect(await readFile(join(tasksDir, ".steer", "busy.md"), "utf-8")).toContain("顺便看看这个");
	});

	it("doctor only reports what a hand edit can still produce", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		await writeFile(
			join(tasksDir, "old.md"),
			'---\nstate: open\ncycle: {"id":"c-1"}\nschedule: 0 9 * * 1\n---\n# Old\n',
		);
		await writeTask("overdue", { state: "parked", ticket: { kind: "time", at: PAST, by: PAST } });
		// Spec 058, D13: a task with no delivery channel is suspended forever unless someone sees it.
		await writeTask("nowhere", { channel: undefined });
		await writeTask("clean");

		const report = await run("doctor");
		expect(report).toContain("`broken`");
		expect(report).toContain("`old`");
		expect(report).toContain("`overdue`");
		expect(report).toContain("`nowhere`");
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
		expect(unknown).toContain("approve");
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
