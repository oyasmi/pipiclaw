import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TOOLS_CONFIG } from "../src/config/tools.js";
import { createFileStore } from "../src/file-store.js";
import { DEFAULT_SECURITY_CONFIG } from "../src/security/config.js";
import { createUsage } from "../src/tasks/budget.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/contract.js";
import type { TaskControl, TaskSessionContext, TaskStepIntent } from "../src/tasks/control.js";
import { deliverTaskMessage, queueTaskReport } from "../src/tasks/delivery.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { appendTaskLog, readTaskLog, resetTaskLogAppenders } from "../src/tasks/loop-log.js";
import { beginStep, closeTask as closeStoredTask, readStoredTask } from "../src/tasks/store.js";
import { buildToolSet } from "../src/tools/registry.js";
import { createTask } from "../src/tools/task-manage/create.js";
import {
	createTaskAskTool,
	createTaskCloseTool,
	createTaskMessageTool,
	createTaskReportTool,
	createTaskWaitTool,
} from "../src/tools/task-manage/factory.js";
import { closeTaskFromChat } from "../src/tools/task-manage/lifecycle.js";
import type { TaskManageToolOptions } from "../src/tools/task-manage/types.js";
import { testManagers } from "./helpers/background-runtime.js";

const CHANNEL_ID = "dingtalk:dm:1";
const SATISFIED_BODY = renderStandardTaskBody({
	title: "Work",
	goal: "Do the work.",
	dod: "- [x] Result is ready",
	items: [{ text: "Build it" }, { text: "Check it" }],
}).replaceAll("- [ ] W", "- [x] W");
const OPEN_DOD_BODY = renderStandardTaskBody({ title: "W", goal: "G", dod: "- [ ] Not yet" });

describe("task tool surfaces (spec 064, D21–D23)", () => {
	let workspaceDir: string;
	let deskDir: string;
	let tasksDir: string;
	let options: TaskManageToolOptions;
	let intent: TaskStepIntent;
	let reports: string[];
	let deliver: boolean;
	let sessionOptions: TaskManageToolOptions;

	const control = {
		isRunning: () => false,
		created: vi.fn<TaskControl["created"]>(),
		snapshot: vi.fn<TaskControl["snapshot"]>(async () => []),
		message: vi.fn<TaskControl["message"]>(async () => ({ kind: "injected" })),
		pause: vi.fn<TaskControl["pause"]>(async () => ({ kind: "ok" })),
		resume: vi.fn<TaskControl["resume"]>(async () => ({ kind: "ok" })),
		cancel: vi.fn<TaskControl["cancel"]>(async () => ({ kind: "cancelled", cancelled: ["run_live"] })),
	} satisfies TaskControl;

	beforeEach(async () => {
		vi.clearAllMocks();
		workspaceDir = await mkdtemp(join(tmpdir(), "task-manage-"));
		deskDir = join(workspaceDir, CHANNEL_ID);
		tasksDir = join(deskDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
		options = { ...testManagers(CHANNEL_ID), desk: "main", deskDir, channelId: CHANNEL_ID, control };
		intent = { reports: 0 };
		reports = [];
		deliver = true;
		const session: TaskSessionContext = {
			taskId: "work",
			seq: () => 2,
			intent: () => intent,
			report: async (text) => {
				reports.push(text);
				const message = await queueTaskReport(deskDir, "work", 2, CHANNEL_ID, text);
				const delivered = await deliverTaskMessage(deskDir, message.id, async () => deliver);
				return { id: message.id, delivered };
			},
		};
		sessionOptions = { ...options, control: undefined, session };
	});

	afterEach(async () => {
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, fields: Partial<TaskFrontmatter> = {}, body = SATISFIED_BODY): Promise<void> {
		await writeFile(
			join(tasksDir, `${id}.md`),
			renderTaskDocument({ state: "queued", usage: createUsage(), ...fields }, body),
		);
		await appendTaskLog(deskDir, id, { kind: "step", seq: 2, reason: "start", brief: "full" });
		await appendTaskLog(deskDir, id, { kind: "report", seq: 2, text: "checked", delivered: true });
	}

	/** An unsettled delegation bound to `taskId`, as the run manager would hold it mid-flight. */
	async function startRun(taskId: string, runId = "run_live"): Promise<void> {
		await options.runManager.register({
			runId,
			channelId: CHANNEL_ID,
			runtime: "internal",
			agent: "builder",
			label: "build",
			source: "predefined",
			tools: [],
			purpose: "work",
			taskId,
			workingDirectory: workspaceDir,
			artifactDir: join(workspaceDir, "artifacts", runId),
		});
	}

	describe("task_create", () => {
		it("creates the task queued with its usage clock started and numbered Work Items", async () => {
			const result = await createTask(options, {
				id: "work",
				title: "Work",
				goal: "G",
				dod: "- [ ] Done",
				items: [{ text: "first" }, { text: "second" }],
				budget: { steps: 12, usd: 3 },
			});
			expect(result).toMatchObject({ state: "queued" });
			const document = await readStoredTask(deskDir, "work");
			expect(document?.fields.usage).toMatchObject({ steps: 0, usd: 0 });
			expect(document?.fields.budget).toEqual({ steps: 12, usd: 3 });
			expect(document?.body).toContain("- [ ] W2 second");
		});

		it("keeps ids, DoD and budget strict", async () => {
			await expect(createTask(options, { id: "bad/id", title: "B", goal: "G", dod: "- [ ] D" })).rejects.toThrow(
				/Invalid task id/,
			);
			await expect(createTask(options, { id: "no-dod", title: "N", goal: "G", dod: "prose" })).rejects.toThrow(
				/no checklist items/,
			);
			await createTask(options, { id: "dup", title: "D", goal: "G", dod: "- [ ] D" });
			await expect(createTask(options, { id: "dup", title: "D", goal: "G", dod: "- [ ] D" })).rejects.toThrow(
				/already exists/,
			);
		});
	});

	describe("task_close", () => {
		it("from chat: completes a task nothing is working on, under the same gates as the leader", async () => {
			await writeTask("done");
			expect(await closeTaskFromChat(options, { id: "done", outcome: "complete", note: "Finished." })).toMatchObject(
				{
					archived: true,
				},
			);
			expect(existsSync(join(tasksDir, "done.md"))).toBe(false);
			expect(await readFile(join(tasksDir, "archive", "done.jsonl"), "utf-8")).toContain('"by":"user"');

			await writeTask("gated", {}, OPEN_DOD_BODY);
			await expect(closeTaskFromChat(options, { id: "gated", outcome: "complete", note: "x" })).rejects.toThrow(
				/unmet acceptance items/,
			);
			await writeTask("busy", { state: "running" });
			await expect(closeTaskFromChat(options, { id: "busy", outcome: "complete", note: "x" })).rejects.toThrow(
				/executing a step/,
			);
			// R7: admission during the async work check invalidates completion's earlier snapshot.
			await writeTask("race");
			const originalJobs = options.jobManager;
			options.jobManager = {
				list: async () => {
					await beginStep(deskDir, "race", { brief: "full" });
					return [];
				},
			} as never;
			await expect(closeTaskFromChat(options, { id: "race", outcome: "complete", note: "done" })).rejects.toThrow(
				/changed during completion/,
			);
			expect((await readStoredTask(deskDir, "race"))?.fields.state).toBe("running");
			options.jobManager = originalJobs;
			await writeTask("flying");
			await startRun("flying");
			await expect(closeTaskFromChat(options, { id: "flying", outcome: "complete", note: "x" })).rejects.toThrow(
				/work in flight[\s\S]*End the step/,
			);
		});

		it("from chat: cancel goes through the lane, which stops the step and what the task started", async () => {
			await writeTask("doomed", { state: "running" });
			const result = await closeTaskFromChat(options, {
				id: "doomed",
				outcome: "cancel",
				note: "No longer needed.",
			});
			expect(control.cancel).toHaveBeenCalledWith("main", "doomed", {
				by: "user",
				note: "No longer needed.",
				channel: CHANNEL_ID,
			});
			expect(result).toMatchObject({ archived: true, cancelled: ["run_live"] });
		});

		it("in a task session: registers the close as the step's intent — the lane archives it when the step ends", async () => {
			await writeTask("work");
			const tool = createTaskCloseTool(sessionOptions);
			await rm(join(tasksDir, "work.jsonl"));
			await expect(tool.execute("c", { id: "work", outcome: "complete", note: "done" } as never)).rejects.toThrow(
				/final report/,
			);
			deliver = false;
			await createTaskReportTool(sessionOptions).execute("r", { text: "final evidence" });
			const report = (await readTaskLog(deskDir, "work", { kinds: ["report"] }))[0]!;
			await expect(
				closeStoredTask(deskDir, "work", { outcome: "complete", by: "leader", note: "done", reportId: report.id }),
			).rejects.toThrow(/not confirmed delivered/);
			const result = await tool.execute("c", { id: "work", outcome: "complete", note: "All checked." } as never);
			expect(result.terminate).toBe(true);
			expect(intent.close).toMatchObject({
				outcome: "complete",
				note: "All checked.",
				reportId: expect.any(String),
			});
			expect(existsSync(join(tasksDir, "work.md"))).toBe(true);

			await expect(tool.execute("c", { id: "other", outcome: "cancel", note: "n" } as never)).rejects.toThrow(
				/close only this task/,
			);
		});

		it("in a task session: complete is refused while the DoD is open or work is in flight, and a refusal ends nothing", async () => {
			await writeTask("work", {}, OPEN_DOD_BODY);
			const tool = createTaskCloseTool(sessionOptions);
			await expect(tool.execute("c", { id: "work", outcome: "complete", note: "n" } as never)).rejects.toThrow(
				/unmet acceptance items/,
			);
			await writeTask("work", {}, SATISFIED_BODY.replace("- [x] W1", "- [ ] W1"));
			await expect(tool.execute("c", { id: "work", outcome: "complete", note: "n" } as never)).rejects.toThrow(
				/unfinished Work Items.*W1/,
			);
			await writeTask("work", {}, "# Work\n\n## DoD\n");
			await expect(tool.execute("c", { id: "work", outcome: "complete", note: "n" } as never)).rejects.toThrow(
				/no checklist items/,
			);
			await writeTask("work");
			await startRun("work");
			await expect(tool.execute("c", { id: "work", outcome: "complete", note: "n" } as never)).rejects.toThrow(
				/in-flight work wakes you when it settles/,
			);
			expect(intent.close).toBeUndefined();
			// Cancel has no gate: abandoning work must always be possible.
			expect((await tool.execute("c", { id: "work", outcome: "cancel", note: "n" } as never)).terminate).toBe(true);
		});
	});

	describe("task_ask, task_wait and task_report", () => {
		it("end the step on success and refuse each other, with the intent already registered named", async () => {
			await writeTask("work");
			const ask = createTaskAskTool(sessionOptions);
			const wait = createTaskWaitTool(sessionOptions);
			expect((await wait.execute("c", { until: "+2h" } as never)).terminate).toBe(true);
			expect(intent.waitUntil).toBeDefined();
			await expect(ask.execute("c", { question: "merge?" } as never)).rejects.toThrow(
				/already registered task_wait/,
			);
			intent.waitUntil = undefined;

			expect((await ask.execute("c", { question: "merge?" } as never)).terminate).toBe(true);
			await expect(wait.execute("c", { until: "+2h" } as never)).rejects.toThrow(/already registered task_ask/);
			await expect(ask.execute("c", { question: "again?" } as never)).rejects.toThrow(/already registered/);
			const records = await readTaskLog(deskDir, "work", { kinds: ["wait", "ask"] });
			expect(records.map((record) => record.kind)).toEqual(["wait", "ask"]);
			expect(records[1]).toMatchObject({ seq: 2, question: "merge?" });
		});

		it("task_wait keeps its moment within one minute and thirty days; task_ask within 500 characters", async () => {
			await writeTask("work");
			const wait = createTaskWaitTool(sessionOptions);
			await expect(wait.execute("c", { until: "+10s" } as never)).rejects.toThrow(/less than a minute/);
			await expect(wait.execute("c", { until: "+40d" } as never)).rejects.toThrow(/30 days/);
			await expect(
				createTaskAskTool(sessionOptions).execute("c", { question: "q".repeat(501) } as never),
			).rejects.toThrow(/500/);
			expect(intent.waitUntil).toBeUndefined();
			expect(intent.ask).toBeUndefined();
		});

		it("task_report sends at once, records whether it arrived, and stops at three a step", async () => {
			await writeTask("work");
			const report = createTaskReportTool(sessionOptions);
			deliver = false;
			expect((await report.execute("c", { text: "one" } as never)).details).toMatchObject({ action: "report" });
			deliver = true;
			await report.execute("c", { text: "two" } as never);
			await report.execute("c", { text: "three" } as never);
			await expect(report.execute("c", { text: "four" } as never)).rejects.toThrow(/already sent 3 reports/);
			expect(reports).toEqual(["one", "two", "three"]);
			expect(
				(await readTaskLog(deskDir, "work", { kinds: ["report"] }))
					.slice(-3)
					.map((record) => record.kind === "report" && record.delivered),
			).toEqual([false, true, true]);
		});
	});

	describe("the chat management tools", () => {
		it("relay the user's words verbatim and say where they landed; an unknown task is the model's to fix", async () => {
			const message = createTaskMessageTool(options);
			const result = await message.execute("c", { id: "work", text: "  先跑 check  " } as never);
			expect(control.message).toHaveBeenCalledWith("main", "work", {
				from: "chat",
				channel: CHANNEL_ID,
				text: "先跑 check",
			});
			expect(result.details).toMatchObject({ action: "message", id: "work" });

			control.message.mockResolvedValueOnce({ kind: "not_found" });
			await expect(message.execute("c", { id: "nope", text: "hi" } as never)).rejects.toThrow(/task_list/);
		});

		it("are offered to chat only, and the session tools to a task session only — none writes state", () => {
			const ctx = (extra: Partial<Parameters<typeof buildToolSet>[0]> = {}) =>
				buildToolSet({
					executor: { exec: async () => ({ stdout: "", stderr: "", code: 1 }) },
					fileStore: createFileStore(),
					securityConfig: DEFAULT_SECURITY_CONFIG,
					securityContext: { agentWorkspaceDir: workspaceDir, cwd: workspaceDir },
					channelId: CHANNEL_ID,
					desk: "main",
					deskDir,
					workspaceDir,
					toolsConfig: DEFAULT_TOOLS_CONFIG,
					jobManager: options.jobManager,
					runManager: options.runManager,
					getCurrentModel: () => ({}) as never,
					getAvailableModels: () => [],
					resolveApiKey: async () => "key",
					getSessionSearchSettings: () => ({}) as never,
					...extra,
				}).map((tool) => tool.name);
			const chat = ctx({ taskControl: control });
			const inSession = ctx({ taskSession: sessionOptions.session });
			const taskTools = (names: string[]) => names.filter((name) => name.startsWith("task_")).sort();
			expect(taskTools(chat)).toEqual([
				"task_close",
				"task_create",
				"task_list",
				"task_log",
				"task_message",
				"task_pause",
				"task_resume",
			]);
			expect(taskTools(inSession)).toEqual(["task_ask", "task_close", "task_log", "task_report", "task_wait"]);
			expect([...chat, ...inSession]).not.toContain("task_update");
			expect([...chat, ...inSession]).not.toContain("task_step_end");
		});
	});
});
