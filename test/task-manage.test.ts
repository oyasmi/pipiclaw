import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manageTask, type TaskManageToolOptions } from "../src/tools/task-manage.js";

const CHANNEL_ID = "dm_1";

function taskDoc(front: string, body: string): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("manageTask", () => {
	let workspaceDir: string;
	let channelDir: string;
	let tasksDir: string;
	let eventsDir: string;
	let options: TaskManageToolOptions;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-manage-"));
		channelDir = join(workspaceDir, CHANNEL_ID);
		tasksDir = join(channelDir, "tasks");
		eventsDir = join(workspaceDir, "events");
		await mkdir(tasksDir, { recursive: true });
		await mkdir(eventsDir, { recursive: true });
		options = { workspaceDir, workspacePath: "/ws", channelDir, channelId: CHANNEL_ID };
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, front: string, body: string): Promise<void> {
		await writeFile(join(tasksDir, `${id}.md`), taskDoc(front, body));
	}
	async function writeEvent(name: string, event: object): Promise<void> {
		await writeFile(join(eventsDir, `${name}.json`), JSON.stringify(event));
	}

	describe("create", () => {
		it("creates a standard task skeleton", async () => {
			const result = await manageTask(options, {
				action: "create",
				id: "weekly-report",
				title: "Weekly Report",
				goal: "Publish the weekly report after user confirmation.",
				dod: "- [ ] Draft reviewed\n- [ ] Report published",
				manual: "Collect inputs, draft, ask for confirmation, publish.",
				status: "in-progress",
				wake: "2026-07-08T14:00:00+08:00",
				recurrence: "每周一",
			});
			expect(result.status).toBe("in-progress");
			const onDisk = await readFile(join(tasksDir, "weekly-report.md"), "utf-8");
			expect(onDisk).toContain("status: in-progress");
			expect(onDisk).toContain("wake: 2026-07-08T14:00:00+08:00");
			expect(onDisk).toContain("recurrence: 每周一");
			expect(onDisk).toContain("# Weekly Report");
			expect(onDisk).toContain("## Goal");
			expect(onDisk).toContain("## DoD");
			expect(onDisk).toContain("## Manual");
			expect(onDisk).toContain("## Current Cycle");
			expect(onDisk).toContain("## History");
		});

		it("rejects create without required body fields", async () => {
			await expect(
				manageTask(options, {
					action: "create",
					id: "thin",
					title: "Thin task",
					goal: "Do something",
				}),
			).rejects.toThrow(/requires dod/);
		});

		it("rejects duplicate active task ids", async () => {
			await manageTask(options, {
				action: "create",
				id: "dup",
				title: "Duplicate",
				goal: "Do it",
				dod: "- [ ] Done",
			});
			await expect(
				manageTask(options, {
					action: "create",
					id: "dup",
					title: "Duplicate again",
					goal: "Do it again",
					dod: "- [ ] Done",
				}),
			).rejects.toThrow(/already exists/);
		});
	});

	describe("set", () => {
		it("rewrites only the frontmatter, preserving the body verbatim", async () => {
			const body = "# 周报\n\n## 目标\n每周一\n\n## 当前周期\n- 草稿已发";
			await writeTask("weekly", "status: open\nrecurrence: 每周一", body);
			const result = await manageTask(options, {
				action: "set",
				id: "weekly",
				status: "awaiting-user",
				wake: "2026-07-08T14:00:00+08:00",
			});
			expect(result.status).toBe("awaiting-user");
			const onDisk = await readFile(join(tasksDir, "weekly.md"), "utf-8");
			expect(onDisk).toBe(
				taskDoc("status: awaiting-user\nwake: 2026-07-08T14:00:00+08:00\nrecurrence: 每周一", body),
			);
		});

		it("clears wake when given an empty string", async () => {
			await writeTask("t", "status: blocked\nwake: 2026-07-08T14:00:00+08:00", "# T\nbody");
			await manageTask(options, { action: "set", id: "t", wake: "" });
			const onDisk = await readFile(join(tasksDir, "t.md"), "utf-8");
			expect(onDisk).not.toContain("wake:");
		});

		it("rejects an invalid wake", async () => {
			await writeTask("t", "status: open", "# T");
			await expect(manageTask(options, { action: "set", id: "t", wake: "soon" })).rejects.toThrow(/ISO8601/);
		});

		it("rejects setting status to done (use action done)", async () => {
			await writeTask("t", "status: open", "# T");
			await expect(manageTask(options, { action: "set", id: "t", status: "done" })).rejects.toThrow(/done/);
		});

		it("fails closed on unreadable frontmatter", async () => {
			await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
			await expect(manageTask(options, { action: "set", id: "broken", status: "open" })).rejects.toThrow(
				/no readable frontmatter/,
			);
		});

		it("rejects a missing task", async () => {
			await expect(manageTask(options, { action: "set", id: "ghost", status: "open" })).rejects.toThrow(
				/does not exist/,
			);
		});
	});

	describe("done", () => {
		it("archives a one-shot task and deletes its residual one-shot events", async () => {
			await writeTask("fix-bug", "status: in-progress", "# Fix bug");
			await writeEvent("task.dm_1.fix-bug.checkin", {
				type: "one-shot",
				channelId: CHANNEL_ID,
				text: "推进任务 fix-bug",
				at: "2026-07-09T10:00:00+08:00",
			});
			await writeEvent("task.dm_1.fix-bug.agentmux", {
				type: "periodic",
				channelId: CHANNEL_ID,
				text: "推进任务 fix-bug（agentmux 已就绪）",
				schedule: "*/10 * * * *",
				timezone: "Asia/Shanghai",
				preAction: { type: "bash", command: "agentmux inspect helper" },
			});
			const result = await manageTask(options, {
				action: "done",
				id: "fix-bug",
				summary: "Fixed the login crash.",
				evidence: "npm test -- login passed.",
			});
			expect(result.archived).toBe(true);
			expect(result.deletedEvents).toEqual(["task.dm_1.fix-bug.agentmux", "task.dm_1.fix-bug.checkin"]);
			expect(existsSync(join(tasksDir, "fix-bug.md"))).toBe(false);
			expect(existsSync(join(tasksDir, "archive", "fix-bug.md"))).toBe(true);
			expect(existsSync(join(eventsDir, "task.dm_1.fix-bug.checkin.json"))).toBe(false);
			expect(existsSync(join(eventsDir, "task.dm_1.fix-bug.agentmux.json"))).toBe(false);
			const archived = await readFile(join(tasksDir, "archive", "fix-bug.md"), "utf-8");
			expect(archived).toContain("## Completion Evidence");
			expect(archived).toContain("- Summary: Fixed the login crash.");
			expect(archived).toContain("- Evidence: npm test -- login passed.");
		});

		it("keeps a periodic task in place and preserves its schedule event", async () => {
			await writeTask("weekly", "status: in-progress\nrecurrence: 每周一", "# Weekly");
			await writeEvent("task.dm_1.weekly.schedule", {
				type: "periodic",
				channelId: CHANNEL_ID,
				text: "推进任务 weekly",
				schedule: "0 9 * * 1",
				timezone: "Asia/Shanghai",
			});
			await writeEvent("task.dm_1.weekly.checkin", {
				type: "one-shot",
				channelId: CHANNEL_ID,
				text: "回访",
				at: "2026-07-09T10:00:00+08:00",
			});
			await writeEvent("task.dm_1.weekly.agentmux", {
				type: "periodic",
				channelId: CHANNEL_ID,
				text: "回访委派",
				schedule: "*/10 * * * *",
				timezone: "Asia/Shanghai",
				preAction: { type: "bash", command: "agentmux inspect helper" },
			});
			const result = await manageTask(options, {
				action: "done",
				id: "weekly",
				summary: "Published this week's report.",
				evidence: "User confirmed the report was posted.",
				residualRisk: "Next week still needs data source X checked.",
			});
			expect(result.archived).toBe(false);
			expect(existsSync(join(tasksDir, "weekly.md"))).toBe(true);
			// schedule survives; lifecycle check-ins (one-shot or periodic sensors) are cleaned up.
			expect(existsSync(join(eventsDir, "task.dm_1.weekly.schedule.json"))).toBe(true);
			expect(existsSync(join(eventsDir, "task.dm_1.weekly.checkin.json"))).toBe(false);
			expect(existsSync(join(eventsDir, "task.dm_1.weekly.agentmux.json"))).toBe(false);
			const onDisk = await readFile(join(tasksDir, "weekly.md"), "utf-8");
			expect(onDisk).toContain("status: done");
			expect(onDisk).toContain("- Summary: Published this week's report.");
			expect(onDisk).toContain("- Evidence: User confirmed the report was posted.");
			expect(onDisk).toContain("- Residual risk: Next week still needs data source X checked.");
		});

		it("requires close-out summary and evidence", async () => {
			await writeTask("t", "status: in-progress", "# T");
			await expect(manageTask(options, { action: "done", id: "t", summary: "Done" })).rejects.toThrow(
				/requires evidence/,
			);
		});
	});

	describe("list", () => {
		it("returns structured active tasks", async () => {
			await writeTask("a", "status: in-progress", "# Task A");
			await writeTask("b", "status: done", "# Task B");
			const result = await manageTask(options, { action: "list" });
			expect(result.tasks).toEqual([
				{ id: "a", title: "Task A", status: "in-progress", wake: undefined, actionable: true },
				{ id: "b", title: "Task B", status: "done", wake: undefined, actionable: false },
			]);
		});
	});
});
