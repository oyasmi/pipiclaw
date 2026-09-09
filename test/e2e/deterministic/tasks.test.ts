import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBOOKS_DIR } from "../../../src/paths.js";
import { createTaskDriverEvent } from "../../../src/runtime/task-driver.js";
import { parseTaskFrontmatterV4 } from "../../../src/tasks/frontmatter.js";
import { readActiveTasks } from "../../../src/tasks/ledger.js";
import { readTaskLog } from "../../../src/tasks/log.js";
import { expireTicket, parkTask, readStoredTask } from "../../../src/tasks/store.js";
import { resolveTicket } from "../../../src/tasks/ticket.js";
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

	it("A13b: an expired wait reaches the real task session with its tools, recovery source and completion record", async () => {
		// Regression: bootstrap snapshotted the old wake before installing the brief; the provider
		// missed the contract, guide path and recovery source. Mutation checks: moving context creation
		// before brief installation, or removing task_recovery, makes the provider-input checks fail.
		harness = await createDeterministicHarness({ projectAccess: true });
		harness.model.script.route({
			name: "create-cycle",
			when: (r) => r.isMainTurn && r.lastUserText.includes("seed-cycle"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "Daily",
					goal: "Record one checked result",
					dod: "- [x] Result checked",
					schedule: "0 9 * * *",
				}),
				reply.text("ok"),
			],
		});
		harness.model.script.route({
			name: "recovery-step",
			when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId}]`),
			respond: [
				reply.toolCall("task_step_end", {
					outcome: "done",
					note: "Observed result",
					summary: "Checked result",
					evidence: "Recovery evidence",
				}),
				reply.text("ok"),
			],
		});
		await harness.sendUserMessage("seed-cycle");
		const chatTools = harness.lastMainTurnRequest()?.tools ?? [];
		expect(chatTools).toContain("task_create");
		expect(chatTools).not.toContain("task_step_end");
		const ticket = resolveTicket(
			{ kind: "time", at: "+1m" },
			{
				now: new Date(Date.now() - 2 * 24 * 60 * 60_000),
				taskId,
				channelId: harness.channelId,
				findRun: () => undefined,
				findJob: () => undefined,
				findEvent: () => undefined,
			},
		);
		await parkTask(harness.channelDir, taskId, ticket);
		await expireTicket(harness.channelDir, taskId);
		const entry = (await readActiveTasks(tasksDir())).find((task) => task.id === taskId)!;
		await harness.sendWake(createTaskDriverEvent(harness.channelId, entry, Date.now()).text, {
			user: "TASK_DRIVER",
			userName: "TASK_DRIVER",
		});
		const request = harness.lastMainTurnRequest();
		expect(request?.tools).toContain("task_step_end");
		for (const unavailable of ["task_create", "event_manage", "memory_save"]) {
			expect(request?.tools).not.toContain(unavailable);
		}
		expect(request?.lastUserText).toContain(join(PLAYBOOKS_DIR, "task-loop.md"));
		expect(request?.lastUserText).toContain(activePath());
		expect(request?.lastUserText).toContain('<task_recovery kind="expired">');
		const closed = await readStoredTask(harness.channelDir, taskId);
		expect(closed?.fields.ticket?.kind).toBe("schedule");
		expect(
			(await readTaskLog(harness.channelDir, taskId, { kinds: ["close"] })).map(
				(record) => record.kind === "close" && record.outcome,
			),
		).toEqual(["done"]);
	});

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
			when: (r) => r.isMainTurn && r.lastUserText.includes("[TASK_STEP:"),
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

	it("A14: a task step leaves the channel's session commands intact", async () => {
		// A task cycle runs in its own session (D3), which replaces the bound AgentSession twice
		// per step. The replacement session must come up with the command extension loaded, or
		// every session command silently degrades into a plain LLM turn. Mutation check: drop the
		// `loadSessionResources` call in `createSessionRuntime` and `/model` reaches the model.
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
			when: (r) => r.isMainTurn && r.lastUserText.includes("[TASK_STEP:"),
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
		const entry = (await readActiveTasks(tasksDir())).find((e) => e.id === taskId);
		const driver = createTaskDriverEvent(harness.channelId, entry!, Date.now());
		await harness.sendWake(driver.text, { user: "TASK_DRIVER", userName: "TASK_DRIVER" });

		const requestsBefore = harness.modelRequestCount();
		const deliveriesBefore = harness.deliveries.length;
		await harness.sendUserMessage("/model");
		expect(harness.modelRequestCount()).toBe(requestsBefore);
		const replies = harness.deliveries.slice(deliveriesBefore).map((d) => d.text ?? "");
		expect(replies.some((text) => text.includes("当前模型"))).toBe(true);
	});
});
