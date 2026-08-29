import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskDriverEvent } from "../../../src/runtime/task-driver.js";
import { parseTaskFrontmatter, readActiveTasks } from "../../../src/tasks/ledger.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";

describe("E2E deterministic: task lifecycle", () => {
	let harness: DeterministicHarness;
	const taskId = "e2e-det-task";
	afterEach(async () => {
		harness.assertNoUnmatchedRequests();
		await harness.shutdown();
	});

	const tasksDir = () => join(harness.channelDir, "tasks");
	const activePath = () => join(tasksDir(), `${taskId}.md`);
	const archivedPath = () => join(tasksDir(), "archive", `${taskId}.md`);
	const currentPath = () => (existsSync(archivedPath()) ? archivedPath() : activePath());

	it("A13: create → real driver wake → update → close, control block stays parseable", async () => {
		// Locks F3: the wake prompt is built from the real createTaskDriverEvent, not a
		// hand-copied paraphrase. Mutation check: skip the atomic control-block rewrite in
		// the task ledger writer and parseTaskFrontmatter(after).readable flips to false.
		harness = await createDeterministicHarness();

		harness.model.script.route({
			name: "create",
			when: (r) => r.isMainTurn && r.lastUserText.includes("建个任务"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "记录一个数字",
					goal: "把数字 42 记录到任务里",
					dod: "- [ ] 把 42 记录到 Current Cycle",
				}),
				reply.text("任务已创建。"),
			],
		});
		harness.model.script.route({
			name: "drive",
			when: (r) => r.isMainTurn && r.lastUserText.includes("Resume task"),
			respond: [
				reply.toolCall("task_update", { id: taskId, note: "已在 Current Cycle 记录数字 42。" }),
				reply.toolCall("task_close", {
					id: taskId,
					outcome: "complete",
					summary: "已记录 42",
					evidence: "Current Cycle 含 42",
				}),
				reply.text("[SILENT]"),
			],
			repeat: true,
		});

		await harness.sendUserMessage("帮我建个任务");
		expect(existsSync(activePath())).toBe(true);
		const created = parseTaskFrontmatter(readFileSync(activePath(), "utf-8"));
		expect(created.readable).toBe(true);
		expect(created.status).not.toBe("done");

		// Wake it exactly as production does.
		const entry = (await readActiveTasks(tasksDir())).find((e) => e.id === taskId);
		expect(entry).toBeDefined();
		const driver = createTaskDriverEvent(harness.channelId, entry!, Date.now());
		await harness.sendWake(driver.text, { user: "TASK_DRIVER", userName: "TASK_DRIVER" });

		const after = readFileSync(currentPath(), "utf-8");
		expect(after).toContain("42");
		expect(parseTaskFrontmatter(after).readable).toBe(true);
	});
});
