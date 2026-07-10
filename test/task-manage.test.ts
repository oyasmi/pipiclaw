import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeVerificationAttestation } from "../src/tasks/verification.js";
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

		it("fails closed on invalid control except for an explicit governed repair", async () => {
			await writeTask("broken-control", "status: open\ncontrol: {bad", "# Broken\n\n## Current Cycle\n- x");
			await expect(
				manageTask(options, { action: "progress", id: "broken-control", note: "continue" }),
			).rejects.toThrow(/invalid control metadata/);
			await manageTask(options, {
				action: "set",
				id: "broken-control",
				control: { priority: "high", verificationMode: "independent" },
			});
			const repaired = await readFile(join(tasksDir, "broken-control.md"), "utf-8");
			expect(repaired).toContain('"priority":"high"');
			expect(repaired).toContain('"mode":"independent"');
		});

		it("rejects a missing task", async () => {
			await expect(manageTask(options, { action: "set", id: "ghost", status: "open" })).rejects.toThrow(
				/does not exist/,
			);
		});
	});

	describe("progress", () => {
		it("atomically appends a cycle note and updates status/wake", async () => {
			await manageTask(options, {
				action: "create",
				id: "long-work",
				title: "Long work",
				goal: "Finish safely",
				dod: "- [ ] Tests pass",
			});
			const result = await manageTask(options, {
				action: "progress",
				id: "long-work",
				note: "Implemented parser; targeted tests pass; next: integration test.",
				status: "in-progress",
				wake: "2026-07-08T14:00:00+08:00",
			});
			expect(result.status).toBe("in-progress");
			const onDisk = await readFile(join(tasksDir, "long-work.md"), "utf-8");
			expect(onDisk).toContain("wake: 2026-07-08T14:00:00+08:00");
			expect(onDisk).toContain("- Implemented parser; targeted tests pass; next: integration test.");
		});

		it("requires a note and a standard Current Cycle section", async () => {
			await writeTask("thin", "status: open", "# Thin");
			await expect(manageTask(options, { action: "progress", id: "thin" })).rejects.toThrow(/requires note/);
			await expect(manageTask(options, { action: "progress", id: "thin", note: "Started." })).rejects.toThrow(
				/normalize the task skeleton/,
			);
		});
	});

	describe("done", () => {
		it("requires and consumes an independent verifier attestation for governed tasks", async () => {
			await manageTask(options, {
				action: "create",
				id: "verified",
				title: "Verified task",
				goal: "Ship a verified result",
				dod: "- [x] Result exists",
			});
			await expect(
				manageTask(options, {
					action: "done",
					id: "verified",
					summary: "Done",
					evidence: "Observed result",
				}),
			).rejects.toThrow(/independent PASS/);

			await writeVerificationAttestation(channelDir, {
				runId: "verify-run-1",
				taskId: "verified",
				verdict: "pass",
				agent: "reviewer",
				model: "test/model",
				checkedAt: new Date().toISOString(),
				evidence: "The result and deterministic check both pass.",
				workspaceChanged: false,
				output: "VERDICT: PASS",
			});
			await manageTask(options, {
				action: "verify",
				id: "verified",
				verifierRunId: "verify-run-1",
			});
			const result = await manageTask(options, {
				action: "done",
				id: "verified",
				summary: "Done",
				evidence: "Independent run verify-run-1 passed.",
			});
			expect(result.archived).toBe(true);
		});

		it("gates completion on unfinished children and rejects parent/dependency cycles", async () => {
			for (const [id, parent] of [
				["parent", undefined],
				["child", "parent"],
			] as const) {
				await manageTask(options, {
					action: "create",
					id,
					title: id,
					goal: `Finish ${id}`,
					dod: "- [x] complete",
					control: { verificationMode: "evidence", parent },
				});
			}
			await expect(
				manageTask(options, {
					action: "done",
					id: "parent",
					summary: "Done",
					evidence: "Checked",
				}),
			).rejects.toThrow(/unfinished child/);
			await expect(
				manageTask(options, { action: "set", id: "parent", control: { parent: "child" } }),
			).rejects.toThrow(/parent cycle/);
			await expect(
				manageTask(options, { action: "set", id: "parent", control: { dependsOn: ["child"] } }),
			).resolves.toMatchObject({ status: "open" });

			for (const id of ["dep-a", "dep-b"]) {
				await manageTask(options, {
					action: "create",
					id,
					title: id,
					goal: `Finish ${id}`,
					dod: "- [x] complete",
					control: { verificationMode: "evidence" },
				});
			}
			await manageTask(options, { action: "set", id: "dep-a", control: { dependsOn: ["dep-b"] } });
			await expect(
				manageTask(options, { action: "set", id: "dep-b", control: { dependsOn: ["dep-a"] } }),
			).rejects.toThrow(/dependency cycle/);
		});

		it("does not let the agent self-grant external approval", async () => {
			await manageTask(options, {
				action: "create",
				id: "publish",
				title: "Publish",
				goal: "Publish externally",
				dod: "- [ ] published",
				control: { verificationMode: "evidence", sideEffects: "external" },
			});
			await expect(
				manageTask(options, { action: "set", id: "publish", control: { externalApproval: "granted" } }),
			).rejects.toThrow(/\/tasks approve/);
		});

		it("rejects unchecked structured acceptance items", async () => {
			await manageTask(options, {
				action: "create",
				id: "unchecked",
				title: "Unchecked",
				goal: "Finish all checks",
				dod: "- [x] implementation exists\n- [ ] integration test passes",
				control: { verificationMode: "evidence" },
			});
			await expect(
				manageTask(options, {
					action: "done",
					id: "unchecked",
					summary: "Done",
					evidence: "Implementation checked",
				}),
			).rejects.toThrow(/integration test passes/);
		});

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

	describe("start-cycle", () => {
		it("opens a completed recurring task with fresh cycle-scoped control", async () => {
			await manageTask(options, {
				action: "create",
				id: "weekly",
				title: "Weekly",
				goal: "Publish weekly work",
				dod: "- [x] published",
				recurrence: "weekly",
				control: { verificationMode: "evidence", sideEffects: "external" },
			});
			const path = join(tasksDir, "weekly.md");
			let onDisk = await readFile(path, "utf-8");
			onDisk = onDisk
				.replace("status: open", "status: done")
				.replace('"attempts":0', '"attempts":7')
				.replace('"status":"pending"', '"status":"passed"');
			await writeFile(path, onDisk);
			const result = await manageTask(options, { action: "start-cycle", id: "weekly", cycleId: "2026-W29" });
			expect(result).toMatchObject({ action: "start-cycle", status: "in-progress" });
			const started = await readFile(path, "utf-8");
			expect(started).toContain("status: in-progress");
			expect(started).toContain('"cycleId":"2026-W29"');
			expect(started).toContain('"attempts":0');
			expect(started).toContain('"externalApproval":"required"');
			expect(started).toContain('"status":"pending"');
			expect(started).toContain("## Current Cycle (2026-W29)");
		});

		it("does not start a second cycle while the current one is still open", async () => {
			await manageTask(options, {
				action: "create",
				id: "weekly",
				title: "Weekly",
				goal: "Publish weekly work",
				dod: "- [ ] published",
				recurrence: "weekly",
			});
			await expect(
				manageTask(options, { action: "start-cycle", id: "weekly", cycleId: "2026-W29" }),
			).rejects.toThrow(/not done/);
		});
	});

	describe("list", () => {
		it("returns structured active tasks", async () => {
			await writeTask("a", "status: in-progress", "# Task A");
			await writeTask("b", "status: done", "# Task B");
			const result = await manageTask(options, { action: "list" });
			expect(result.tasks).toEqual([
				{ id: "a", title: "Task A", status: "in-progress", wake: undefined, actionable: true, control: undefined },
				{ id: "b", title: "Task B", status: "done", wake: undefined, actionable: false, control: undefined },
			]);
		});
	});
});
