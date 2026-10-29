import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUsage } from "../src/tasks/budget.js";
import {
	handleTasksCommand,
	parseTasksCommand,
	renderStopTaskHint,
	renderTaskStatusLine,
} from "../src/tasks/commands.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/contract.js";
import type { TaskControl, TaskLiveSnapshot } from "../src/tasks/control.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { resetTaskLogAppenders } from "../src/tasks/loop-log.js";

const PAST = "2020-01-01T00:00:00+08:00";
const BODY = renderStandardTaskBody({ title: "Weekly", goal: "Ship it.", dod: "- [ ] Shipped" });

describe("/tasks (spec 064, D25)", () => {
	let workspaceDir: string;
	let deskDir: string;
	let tasksDir: string;
	let snapshots: TaskLiveSnapshot[];
	let boundHere: (channelId: string) => boolean;

	const control = {
		isRunning: () => false,
		created: vi.fn<TaskControl["created"]>(),
		snapshot: vi.fn<TaskControl["snapshot"]>(async (_desk, id) =>
			snapshots.filter((snapshot) => id === undefined || snapshot.id === id),
		),
		message: vi.fn<TaskControl["message"]>(async () => ({ kind: "injected" })),
		pause: vi.fn<TaskControl["pause"]>(async () => ({ kind: "ok" })),
		resume: vi.fn<TaskControl["resume"]>(async () => ({ kind: "ok" })),
		cancel: vi.fn<TaskControl["cancel"]>(async () => ({ kind: "cancelled", cancelled: ["run_a"] })),
	} satisfies TaskControl;

	beforeEach(async () => {
		vi.clearAllMocks();
		snapshots = [];
		boundHere = () => true;
		workspaceDir = await mkdtemp(join(tmpdir(), "task-commands-"));
		deskDir = join(workspaceDir, "desk-main");
		tasksDir = join(deskDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
	});
	afterEach(async () => {
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, fields: Partial<TaskFrontmatter> = {}): Promise<void> {
		await writeFile(
			join(tasksDir, `${id}.md`),
			renderTaskDocument({ state: "queued", channel: "dingtalk:dm:1", usage: createUsage(), ...fields }, BODY),
		);
	}

	const run = (args: string) =>
		handleTasksCommand({
			args,
			desk: "main",
			deskDir,
			currentChannelId: "dingtalk:dm:1",
			senderName: "Alice",
			describeChannel: (channelId) => ({ label: `\`${channelId}\``, boundHere: boundHere(channelId) }),
			control,
		});

	it("hands pause, resume, cancel and msg to the lane's port exactly as typed, and answers what happened", async () => {
		await writeTask("weekly");
		expect(await run("pause weekly")).toContain("已暂停");
		expect(control.pause).toHaveBeenCalledWith("main", "weekly", { by: "user", reason: expect.any(String) });
		await run("resume weekly +steps 20 +usd 5");
		expect(control.resume).toHaveBeenCalledWith("main", "weekly", { steps: 20, usd: 5 });
		expect(await run("cancel weekly")).toContain("run_a");
		expect(control.cancel).toHaveBeenCalledWith("main", "weekly", expect.objectContaining({ by: "user" }));
		await run("msg weekly 先跑一遍 npm run check，\n再汇报");
		expect(control.message).toHaveBeenCalledWith("main", "weekly", {
			from: "Alice",
			channel: "dingtalk:dm:1",
			text: "先跑一遍 npm run check，\n再汇报",
		});

		// Each outcome is said differently, so the user knows whether their words reached a step.
		const said = new Set<string>();
		for (const kind of [
			"injected",
			"woke",
			"queued_for_next_step",
			"held_paused",
			"held_frozen",
			"not_found",
		] as const) {
			control.message.mockResolvedValueOnce({ kind });
			said.add(await run("msg weekly hi"));
		}
		expect(said.size).toBe(6);
		control.pause.mockResolvedValueOnce({ kind: "unchanged" });
		expect(await run("pause weekly")).toContain("已经是暂停");
	});

	it("shows what a task is doing right now and what it is waiting for", async () => {
		const now = Date.now();
		await writeTask("busy", { state: "running" });
		await writeTask("results", {
			state: "waiting",
			waiting: { kind: "work", since: new Date(now - 40 * 60_000).toISOString() },
		});
		await writeTask("asking", {
			state: "waiting",
			waiting: { kind: "user", question: "要合并吗？", since: PAST },
		});
		snapshots = [
			{
				id: "busy",
				state: "running",
				frozen: false,
				step: {
					seq: 3,
					startedAt: now - 5 * 60_000,
					toolsDone: 4,
					tool: { summary: "运行 npm test", startedAt: now },
				},
				pending: [],
			},
			{
				id: "results",
				state: "waiting",
				frozen: false,
				pending: [
					{
						ref: "run_k2x9",
						kind: "delegation",
						label: "codex-main",
						startedAt: now - 40 * 60_000,
						lastOutputAt: now - 12 * 60_000,
						stalled: true,
					},
				],
			},
		];

		const list = await run("");
		expect(list).toContain("第 3 步");
		expect(list).toContain("运行 npm test");
		expect(list).toContain("要合并吗？");
		expect(list).toContain("疑似卡住");
		const shown = await run("show results");
		expect(shown).toContain("run_k2x9");
		expect(shown).toContain("没有输出");
		expect(shown).not.toMatch(/waiting|\bwork\b|state:/);
	});

	it("doctor only reports what a hand edit or a stopped lane can produce", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		await writeFile(join(tasksDir, "old.md"), '---\nstate: parked\nticket: {"kind":"ask"}\n---\n# Old\n');
		// Spec 058, D13: a task with no report channel is frozen forever unless someone sees it.
		await writeTask("nowhere", { channel: undefined });
		await writeTask("elsewhere", { channel: "dingtalk:dm:2" });
		boundHere = (channelId) => channelId !== "dingtalk:dm:2";
		await writeTask("stuck", { state: "waiting", waiting: { kind: "work", since: PAST } });
		await writeTask("clean");

		const report = await run("doctor");
		for (const id of ["broken", "old", "nowhere", "elsewhere", "stuck"]) expect(report, id).toContain(`\`${id}\``);
		// A healthy task produces no line at all: doctor is a diagnosis, not an inventory.
		expect(report).not.toContain("clean");
	});

	it("shows archive outcome and rejects path traversal", async () => {
		await writeFile(
			join(tasksDir, "archive", "old.md"),
			renderTaskDocument({ state: "queued", outcome: "completed", closedAt: PAST }, BODY),
		);
		expect(await run("archive")).toContain("old");
		await expect(run("show ../../secret")).resolves.toMatch(/Invalid task id|失败/);
		expect(existsSync(join(tasksDir, "..", "..", "secret.md"))).toBe(false);
	});

	it("parses every documented argument shape and refuses retired ones without writing anything", async () => {
		expect(parseTasksCommand("")).toEqual({ action: "list" });
		expect(parseTasksCommand("cancel x")).toEqual({ action: "cancel", id: "x" });
		expect(parseTasksCommand("msg x 多行 内容 都要保留")).toMatchObject({
			action: "msg",
			text: "多行 内容 都要保留",
		});
		expect(() => parseTasksCommand("msg x")).toThrow(/用法/);
		// `steer` / `reply` / `run` retired with the waiting tickets (spec 064).
		for (const retired of ["steer x hi", "reply x hi", "run x"])
			expect(() => parseTasksCommand(retired)).toThrow(/未知/);

		await writeTask("weekly");
		const before = await readFile(join(tasksDir, "weekly.md"), "utf-8");
		expect(await run("approve weekly")).toContain("approve");
		expect(await readFile(join(tasksDir, "weekly.md"), "utf-8")).toBe(before);
	});

	it("tells /stop and /status users about executing tasks, and says nothing when there are none", () => {
		const snap = (
			id: string,
			state: TaskLiveSnapshot["state"],
			waiting?: TaskLiveSnapshot["waiting"],
		): TaskLiveSnapshot => ({
			id,
			state,
			...(waiting ? { waiting } : {}),
			frozen: false,
			pending: [],
		});
		const all = [
			snap("a", "running"),
			snap("b", "waiting", { kind: "work", since: PAST }),
			snap("c", "queued"),
			snap("d", "waiting", { kind: "user", question: "q", since: PAST }),
		];
		expect(renderStopTaskHint(all)).toMatch(/`a`.*`b`/);
		expect(renderTaskStatusLine(all)).toContain("执行中 2 · 排队 1 · 等你回复 1");
		expect(renderStopTaskHint([snap("c", "queued")])).toBeUndefined();
		expect(renderTaskStatusLine([])).toBeUndefined();
	});
});
