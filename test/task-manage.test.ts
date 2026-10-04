import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUsage } from "../src/tasks/budget.js";
import type { TaskFrontmatter } from "../src/tasks/frontmatter.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { readStoredTask } from "../src/tasks/store.js";
import { createTask } from "../src/tools/task-manage/create.js";
import { closeTask, listTasks, updateTask } from "../src/tools/task-manage/lifecycle.js";
import { endTaskStep } from "../src/tools/task-manage/step-end.js";
import type { TaskManageToolOptions } from "../src/tools/task-manage/types.js";
import { createTaskStepEndTool } from "../src/tools/task-manage.js";
import { testManagers } from "./helpers/background-runtime.js";

const CHANNEL_ID = "dm_1";
const SATISFIED_BODY = renderStandardTaskBody({
	title: "Work",
	goal: "Do the work.",
	dod: "- [x] Result is ready",
	items: [{ text: "Build it" }, { text: "Check it" }],
});
const OPEN_DOD_BODY = renderStandardTaskBody({ title: "W", goal: "G", dod: "- [ ] Not yet" });

describe("task tool surface (spec 052, D7)", () => {
	let workspaceDir: string;
	let channelDir: string;
	let tasksDir: string;
	let options: TaskManageToolOptions;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-manage-"));
		channelDir = join(workspaceDir, CHANNEL_ID);
		tasksDir = join(channelDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
		options = { ...testManagers(CHANNEL_ID), channelDir };
	});

	afterEach(async () => {
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, fields: Partial<TaskFrontmatter> = {}, body = SATISFIED_BODY): Promise<void> {
		await writeFile(
			join(tasksDir, `${id}.md`),
			renderTaskDocument({ state: "open", usage: createUsage(), ...fields }, body),
		);
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
		it("creates the task open with its usage clock started and numbered Work Items", async () => {
			const result = await createTask(options, {
				id: "work",
				title: "Work",
				goal: "G",
				dod: "- [ ] Done",
				items: [{ text: "first" }, { text: "second" }],
				budget: { steps: 12, usd: 3 },
			});
			expect(result).toMatchObject({ state: "open" });
			const document = await readStoredTask(channelDir, "work");
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
			await expect(
				createTask(options, { id: "bad-budget", title: "B", goal: "G", dod: "- [ ] D", budget: { usd: -1 } }),
			).rejects.toThrow(/positive number/);
			await createTask(options, { id: "dup", title: "D", goal: "G", dod: "- [ ] D" });
			await expect(createTask(options, { id: "dup", title: "D", goal: "G", dod: "- [ ] D" })).rejects.toThrow(
				/already exists/,
			);
		});
	});

	describe("task_update", () => {
		it("edits Work Items and budget without touching task state", async () => {
			await writeTask("edit", {
				state: "parked",
				ticket: { kind: "ask", asked: "?", by: "2099-01-01T00:00:00+08:00" },
			});
			await updateTask(options, {
				id: "edit",
				items: [
					{ id: "W3", text: "Ship it" },
					{ id: "W1", status: "done" },
				],
				budget: { steps: 5 },
			});
			const document = await readStoredTask(channelDir, "edit");
			expect(document?.body).toContain("W3 Ship it");
			expect(document?.body).toContain("- [x] W1 Build it");
			expect(document?.fields.budget?.steps).toBe(5);
			// Metadata edits are not lifecycle moves: the park survives untouched.
			expect(document?.fields.state).toBe("parked");
		});
	});

	describe("task_step_end", () => {
		const loop = (taskId: string): TaskManageToolOptions => ({ ...options, taskId });

		it("is unavailable outside a task loop", async () => {
			await writeTask("work");
			await expect(endTaskStep(options, { outcome: "continue", note: "n" })).rejects.toThrow(
				/only available inside/,
			);
		});

		it("continue keeps the task open, counts the step, and logs the tools it used once each", async () => {
			await writeTask("work");
			const result = await endTaskStep(
				{ ...loop("work"), getToolsUsed: () => ["bash", "read", "bash"] },
				{ outcome: "continue", note: "ran the check" },
			);
			expect(result.state).toBe("open");
			const [record] = await readTaskLog(channelDir, "work", { kinds: ["step"] });
			expect(record).toMatchObject({ kind: "step", seq: 1, outcome: "continue" });
			// Deduplicated: the idle detector asks "did anything happen", not "how many times".
			expect(record?.kind === "step" && record.tools).toEqual(["bash", "read"]);
			expect((await readStoredTask(channelDir, "work"))?.fields.usage?.steps).toBe(1);
		});

		it("can mark a Work Item done in the same call", async () => {
			await writeTask("work");
			await endTaskStep(loop("work"), { outcome: "continue", note: "n", items: [{ id: "W1", status: "done" }] });
			expect((await readStoredTask(channelDir, "work"))?.body).toContain("- [x] W1 Build it");
		});

		it("park requires a ticket, and refuses a work ticket when nothing is in flight", async () => {
			await writeTask("work");
			await expect(endTaskStep(loop("work"), { outcome: "park", note: "n" })).rejects.toThrow(/requires a ticket/);
			await expect(
				endTaskStep(loop("work"), { outcome: "park", note: "n", ticket: { kind: "work" } }),
			).rejects.toThrow(/nothing to wait for|no delegation or background job/);

			await endTaskStep(loop("work"), { outcome: "park", note: "n", ticket: { kind: "time", at: "+2h" } });
			const fields = (await readStoredTask(channelDir, "work"))?.fields;
			expect(fields?.state).toBe("parked");
			expect(fields?.ticket?.by).toBeTruthy();
		});

		it("park on work succeeds only while a bound delegation is in flight, and records what it waits for", async () => {
			await writeTask("work");
			await startRun("work", "run_a");
			await startRun("other", "run_other");
			await endTaskStep(loop("work"), { outcome: "park", note: "waiting", ticket: { kind: "work" } });
			const ticket = (await readStoredTask(channelDir, "work"))?.fields.ticket;
			// Only this task's own delegation counts; another task's run never props up the wait.
			expect(ticket).toMatchObject({ kind: "work", refs: ["run_a"] });
		});

		it("parking on an ask always speaks to the user, with the reply command", async () => {
			await writeTask("work");
			await endTaskStep(loop("work"), {
				outcome: "park",
				note: "n",
				ticket: { kind: "ask", asked: "Merge to master?" },
			});
			const fields = (await readStoredTask(channelDir, "work"))?.fields;
			expect(fields?.ticket).toMatchObject({ kind: "ask", asked: "Merge to master?" });
			// A task waiting on a person that never says so is the silent dead end tickets exist to prevent.
			const notice = await readFile(join(tasksDir, ".steer", "work.out.md"), "utf-8");
			expect(notice).toContain("Merge to master?");
			expect(notice).toContain("/tasks reply work");
		});

		it("stays silent unless the step asked to report", async () => {
			await writeTask("quiet");
			await endTaskStep(loop("quiet"), { outcome: "continue", note: "n" });
			expect(existsSync(join(tasksDir, ".steer", "quiet.out.md"))).toBe(false);
			await endTaskStep(loop("quiet"), { outcome: "continue", note: "n", report: "报告一下" });
			expect(await readFile(join(tasksDir, ".steer", "quiet.out.md"), "utf-8")).toContain("报告一下");
		});

		it("done archives the task with its step and close records, and delivers the report", async () => {
			await writeTask("once");
			await endTaskStep(loop("once"), {
				outcome: "done",
				note: "shipped; npm run check green",
				report: "成果在这里",
			});
			expect(existsSync(join(tasksDir, "once.md"))).toBe(false);
			expect(await readFile(join(tasksDir, "archive", "once.md"), "utf-8")).toContain("outcome: completed");
			// The step must land in the log that travels with the task, not recreate an active one.
			expect(existsSync(join(tasksDir, "once.jsonl"))).toBe(false);
			const archivedLog = await readFile(join(tasksDir, "archive", "once.jsonl"), "utf-8");
			expect(archivedLog).toContain('"kind":"step"');
			expect(archivedLog).toContain('"kind":"close"');
			expect(await readFile(join(tasksDir, ".steer", "once.out.md"), "utf-8")).toContain("成果在这里");
		});

		it("refuses done while acceptance items are unmet, or while bound work is still in flight", async () => {
			await writeTask("open-dod", {}, OPEN_DOD_BODY);
			await expect(endTaskStep(loop("open-dod"), { outcome: "done", note: "n" })).rejects.toThrow(
				/unmet acceptance items/,
			);

			await writeTask("busy");
			await startRun("busy", "run_late");
			// Archiving now would send the late result back into the chat with nobody left to read it.
			await expect(endTaskStep(loop("busy"), { outcome: "done", note: "n" })).rejects.toThrow(/run_late/);
			expect(existsSync(join(tasksDir, "busy.md"))).toBe(true);
		});

		it("a rejected done produces no notice, no state change and no log entry", async () => {
			// Regression: the notice used to fire before the checks, so a rejected `done` still told
			// the channel "task complete" and a corrected retry queued a second one.
			await writeTask("open-dod", {}, OPEN_DOD_BODY);
			const before = await readFile(join(tasksDir, "open-dod.md"), "utf-8");
			await expect(
				endTaskStep(loop("open-dod"), { outcome: "done", note: "n", report: "全部搞定了" }),
			).rejects.toThrow(/unmet acceptance items/);
			expect(existsSync(join(tasksDir, ".steer", "open-dod.out.md"))).toBe(false);
			expect(await readFile(join(tasksDir, "open-dod.md"), "utf-8")).toBe(before);
			expect(await readTaskLog(channelDir, "open-dod")).toEqual([]);
		});

		it("the tool wrapper sets terminate:true on success but not on a recoverable failure", async () => {
			await writeTask("term");
			const tool = createTaskStepEndTool({ ...testManagers(), channelDir, taskId: "term" });
			expect((await tool.execute("c", { outcome: "continue", note: "n" } as never)).terminate).toBe(true);

			await writeTask("term2", {}, OPEN_DOD_BODY);
			await expect(
				createTaskStepEndTool({ ...testManagers(), channelDir, taskId: "term2" }).execute("c", {
					outcome: "done",
					note: "n",
				} as never),
			).rejects.toThrow();
		});
	});

	describe("task_close", () => {
		it("archives a completed task and records the close in the log that travels with it", async () => {
			await writeTask("done");
			const result = await closeTask(options, { id: "done", outcome: "complete", note: "Finished; DoD checked." });
			expect(result).toMatchObject({ archived: true });
			expect(existsSync(join(tasksDir, "done.md"))).toBe(false);
			expect(existsSync(join(tasksDir, "done.jsonl"))).toBe(false);
			expect(await readFile(join(tasksDir, "archive", "done.jsonl"), "utf-8")).toContain('"kind":"close"');
		});

		it("complete obeys the same gates as done; cancel obeys none but reports what keeps running", async () => {
			await writeTask("gated", {}, OPEN_DOD_BODY);
			await expect(closeTask(options, { id: "gated", outcome: "complete", note: "x" })).rejects.toThrow(
				/unmet acceptance items/,
			);

			await startRun("gated", "run_running");
			const cancelled = await closeTask(options, { id: "gated", outcome: "cancel", note: "No longer needed." });
			expect(await readFile(join(tasksDir, "archive", "gated.md"), "utf-8")).toContain("outcome: cancelled");
			// Closing a task never cancels its delegations; the leader has to know that.
			expect(cancelled.notice).toContain("run_running");
		});
	});

	describe("task_list", () => {
		it("summarises state, park and Work Item progress for each live task", async () => {
			await writeTask("open");
			await writeTask("waiting", {
				state: "parked",
				ticket: { kind: "ask", asked: "merge?", by: "2099-01-01T00:00:00+08:00" },
			});
			const result = await listTasks(options);
			expect(result.tasks?.map((task) => task.id).sort()).toEqual(["open", "waiting"]);
			expect(result.tasks?.find((task) => task.id === "waiting")?.ticket).toContain("merge?");
			expect(result.tasks?.find((task) => task.id === "open")?.items).toBe("0/2");
		});
	});
});
