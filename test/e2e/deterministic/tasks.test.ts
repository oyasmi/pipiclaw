import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskDriverEvent } from "../../../src/runtime/task-driver.js";
import { parseTaskFrontmatterV4 } from "../../../src/tasks/frontmatter.js";
import { readActiveTasks } from "../../../src/tasks/ledger.js";
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

	it("A13: create → real driver step → task_step_end closes the cycle, contract stays parseable", async () => {
		// Locks F3: the step prompt is built from the real createTaskDriverEvent, not a
		// hand-copied paraphrase. Mutation check: make `endTaskStep` skip its atomic write and
		// `parseTaskFrontmatterV4(after).readable` flips to false.
		harness = await createDeterministicHarness();

		harness.model.script.route({
			name: "create",
			when: (r) => r.isMainTurn && r.lastUserText.includes("建个任务"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "记录一个数字",
					goal: "把数字 42 记录到任务里",
					dod: "- [x] 把 42 记录下来",
				}),
				reply.text("任务已创建。"),
			],
		});
		harness.model.script.route({
			name: "drive",
			when: (r) => r.isMainTurn && r.lastUserText.includes("Resume task"),
			respond: [
				reply.toolCall("task_step_end", {
					outcome: "done",
					note: "已记录数字 42。",
					summary: "已记录 42",
					evidence: "步骤日志含 42",
				}),
				reply.text("完成。"),
			],
			repeat: true,
		});

		await harness.sendUserMessage("帮我建个任务");
		expect(existsSync(activePath())).toBe(true);
		const created = parseTaskFrontmatterV4(readFileSync(activePath(), "utf-8"));
		expect(created.readable).toBe(true);
		expect(created.fields.state).toBe("open");

		// Wake it exactly as production does.
		const entry = (await readActiveTasks(tasksDir())).find((e) => e.id === taskId);
		expect(entry).toBeDefined();
		const driver = createTaskDriverEvent(harness.channelId, entry!, Date.now());
		await harness.sendWake(driver.text, { user: "TASK_DRIVER", userName: "TASK_DRIVER" });

		// A one-shot `done` archives the contract and leaves its loop log beside it.
		expect(existsSync(activePath())).toBe(false);
		const archived = readFileSync(archivedPath(), "utf-8");
		expect(parseTaskFrontmatterV4(archived).readable).toBe(true);
		expect(archived).toContain("outcome: completed");
		expect(readFileSync(join(tasksDir(), "archive", `${taskId}.jsonl`), "utf-8")).toContain("42");
	});
});
