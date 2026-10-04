import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PLAYBOOKS_DIR } from "../../../src/paths.js";
import { createTaskDriverEvent } from "../../../src/runtime/task-driver.js";
import { createTaskSpawner } from "../../../src/runtime/task-spawn.js";
import { parseTaskFrontmatter } from "../../../src/tasks/frontmatter.js";
import { readActiveTasks } from "../../../src/tasks/ledger.js";
import { readTaskLog } from "../../../src/tasks/log.js";
import { expireTicket, parkTask } from "../../../src/tasks/store.js";
import { resolveTicket } from "../../../src/tasks/ticket.js";
import { createDeterministicHarness, type DeterministicHarness, reply } from "../../support/runtime-harness.js";
import { waitFor } from "../helpers/wait.js";

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
			name: "create",
			when: (r) => r.isMainTurn && r.lastUserText.includes("seed-task"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "Check",
					goal: "Record one checked result",
					dod: "- [x] Result checked",
				}),
				reply.text("ok"),
			],
		});
		harness.model.script.route({
			name: "recovery-step",
			when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId}]`),
			respond: [
				reply.toolCall("task_step_end", { outcome: "done", note: "Observed result; recovery evidence" }),
				reply.text("ok"),
			],
		});
		await harness.sendUserMessage("seed-task");
		const chatTools = harness.lastMainTurnRequest()?.tools ?? [];
		expect(chatTools).toContain("task_create");
		expect(chatTools).not.toContain("task_step_end");
		const ticket = resolveTicket(
			{ kind: "time", at: "+1m" },
			{ now: new Date(Date.now() - 2 * 24 * 60 * 60_000), pendingWork: () => [] },
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
		expect(request?.lastUserText).toContain(join(PLAYBOOKS_DIR, "task-lead.md"));
		expect(request?.lastUserText).toContain(activePath());
		expect(request?.lastUserText).toContain('<task_recovery kind="expired">');
		// The step's brief carries its own task; the channel agenda is chat-side context only.
		// Mutation check: drop the `!this.taskLoop` gate on the digest in ChannelRunner and this fails.
		expect(request?.lastUserText).not.toContain("<task_agenda>");
		expect(existsSync(activePath())).toBe(false);
		expect(
			(await readTaskLog(harness.channelDir, taskId, { kinds: ["close"] })).map(
				(record) => record.kind === "close" && record.outcome,
			),
		).toEqual(["done"]);
	});

	it("A13: create → real driver step → task_step_end closes the cycle, contract stays parseable", async () => {
		// Locks F3: the step prompt is built from the real createTaskDriverEvent, not a
		// hand-copied paraphrase. Mutation check: make `endTaskStep` skip its atomic write and
		// `parseTaskFrontmatter(after).readable` flips to false.
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
					note: "已记录数字 42；步骤日志含 42。",
				}),
				reply.text("完成。"),
			],
			repeat: true,
		});

		await harness.sendUserMessage("帮我建个任务");
		expect(existsSync(activePath())).toBe(true);
		const created = parseTaskFrontmatter(readFileSync(activePath(), "utf-8"));
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
		expect(parseTaskFrontmatter(archived).readable).toBe(true);
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
					note: "已记录数字 42；步骤日志含 42。",
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

	it("A17: a delegation made from a task step binds to the task and Work Item, and its result outlives the step", async () => {
		// Spec 052, D4: the leader never passes taskId from a task session, and the run's dispatch
		// and settlement land in the task's own log. Mutation check: drop `boundTaskId` from the
		// sub-agent tool options in `createPipiclawTools` and the log below has no records.
		harness = await createDeterministicHarness();
		harness.model.script.route({
			name: "child",
			when: (r) => r.systemPrompt.includes("E2E_A17_HELPER"),
			respond: [reply.text("child built it")],
			repeat: true,
		});
		harness.model.script.route({
			name: "create",
			when: (r) => r.isMainTurn && r.lastUserText.includes("建个带工作项的任务"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "带队",
					goal: "让助手做完一件事",
					dod: "- [x] 助手交付了",
					items: [{ text: "助手实现" }],
				}),
				reply.text("任务已创建。"),
			],
		});
		harness.model.script.route({
			name: "lead-step",
			when: (r) => r.isMainTurn && r.lastUserText.includes("[TASK_STEP:"),
			respond: [
				reply.toolCall("subagent_inline", {
					task: "Build it.",
					systemPrompt: "E2E_A17_HELPER.",
					item: "W1",
					mutates: "read",
				}),
				reply.toolCall("task_step_end", {
					outcome: "done",
					note: "W1 由助手完成，已检查。",
					items: [{ id: "W1", status: "done" }],
					report: "全部完成",
				}),
				reply.text("完成。"),
			],
		});

		await harness.sendUserMessage("帮我建个带工作项的任务");
		const entry = (await readActiveTasks(tasksDir())).find((e) => e.id === taskId);
		await harness.sendWake(createTaskDriverEvent(harness.channelId, entry!, Date.now()).text, {
			user: "TASK_DRIVER",
			userName: "TASK_DRIVER",
		});

		const log = await readTaskLog(harness.channelDir, taskId, { kinds: ["dispatch", "settle", "close"] });
		expect(log.map((record) => record.kind)).toEqual(["dispatch", "settle", "close"]);
		expect(log[0]).toMatchObject({ kind: "dispatch", item: "W1" });
		// The result tail is recorded at settlement, so a later step's <task_results> can show it.
		expect(log[1]).toMatchObject({ kind: "settle", item: "W1", status: "completed", tail: "child built it" });
		expect(readFileSync(archivedPath(), "utf-8")).toContain("- [x] W1 助手实现");
	});

	it("A18: a template event's occurrence spawns one instance that runs in its own task session, and a second occurrence is skipped with a receipt", async () => {
		// Spec 052, D2/INV-7. The spawner is wired exactly as bootstrap wires it; the events watcher
		// itself is stubbed out by the harness, so the occurrence is delivered by calling it.
		harness = await createDeterministicHarness();
		const sent: string[] = [];
		const spawn = createTaskSpawner({
			getChannelDir: () => harness.channelDir,
			nudge: () => {},
			notify: async (_channelId, text) => void sent.push(text),
		});
		const template = { title: "周报", goal: "写周报", dod: "- [x] 已写", items: [{ text: "整理" }] };
		const request = (at: string) => ({
			eventName: "weekly",
			channelId: harness.channelId,
			template,
			occurrence: new Date(at),
		});

		const first = await spawn(request("2026-10-05T09:00:00+08:00"));
		expect(first).toEqual({ outcome: "spawned", id: "weekly-20261005-0900" });
		// A replay of the same occurrence is an idempotent no-op — and must not look like a skip.
		expect(await spawn(request("2026-10-05T09:00:00+08:00"))).toEqual({
			outcome: "exists",
			id: "weekly-20261005-0900",
		});
		expect(sent).toEqual([]);
		// The next occurrence finds the first instance still running: skipped, and the user is told.
		const second = await spawn(request("2026-10-12T09:00:00+08:00"));
		expect(second).toEqual({ outcome: "skipped", id: "weekly-20261005-0900" });
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("/tasks show weekly-20261005-0900");

		harness.model.script.route({
			name: "instance-step",
			when: (r) => r.isMainTurn && r.lastUserText.includes("[TASK_STEP:weekly-20261005-0900]"),
			respond: [reply.toolCall("task_step_end", { outcome: "done", note: "周报已写" }), reply.text("ok")],
		});
		const entry = (await readActiveTasks(tasksDir())).find((e) => e.id === "weekly-20261005-0900");
		expect(entry?.fields.origin).toBe("weekly");
		await harness.sendWake(createTaskDriverEvent(harness.channelId, entry!, Date.now()).text, {
			user: "TASK_DRIVER",
			userName: "TASK_DRIVER",
		});
		expect(existsSync(join(tasksDir(), "archive", "weekly-20261005-0900.md"))).toBe(true);
		// Finished, so the following occurrence is free to run.
		expect((await spawn(request("2026-10-19T09:00:00+08:00"))).outcome).toBe("spawned");
	});

	it("A19: a chat message sent during a task step runs as its own chat turn, not as a steer into the task session", async () => {
		// Regression: the busy path steered every plain message into whatever session the runner was
		// bound to, so a message sent while a muted task step ran landed in the task's context and
		// its answer was never delivered. Mutation check: remove the `getTaskLoop` branch in
		// `handleBusyMessage` and no chat-session request carries CHAT_MARKER.
		harness = await createDeterministicHarness({ busyMessageDefault: "steer" });
		harness.model.script.route({
			name: "create",
			when: (r) => r.isMainTurn && r.lastUserText.includes("seed-task"),
			respond: [
				reply.toolCall("task_create", {
					id: taskId,
					title: "Bg",
					goal: "Run in the background",
					dod: "- [x] Done",
				}),
				reply.text("ok"),
			],
		});
		harness.model.script.route({
			name: "step",
			when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId}]`),
			respond: [reply.toolCall("task_step_end", { outcome: "done", note: "done" }), reply.text("ok")],
		});
		harness.model.script.route({
			name: "chat",
			when: (r) => r.isMainTurn && r.lastUserText.includes("CHAT_MARKER"),
			respond: [reply.text("chat answered")],
			repeat: true,
		});
		await harness.sendUserMessage("seed-task");
		const gate = harness.model.script.hold({
			when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId}]`),
		});
		const entry = (await readActiveTasks(tasksDir())).find((e) => e.id === taskId)!;
		harness.enqueueWake(createTaskDriverEvent(harness.channelId, entry, Date.now()).text, {
			user: "TASK_DRIVER",
			userName: "TASK_DRIVER",
		});
		await waitFor("task step running", () =>
			harness.mainTurnRequests().some((r) => r.lastUserText.includes(`[TASK_STEP:${taskId}]`)),
		);
		await harness.sendUserMessageNoWait("顺便问个别的 CHAT_MARKER");
		gate.release();
		await harness.waitForIdle();

		const chatRequests = harness.mainTurnRequests().filter((r) => r.lastUserText.includes("CHAT_MARKER"));
		expect(chatRequests.length).toBeGreaterThan(0);
		for (const request of chatRequests) expect(request.tools).not.toContain("task_step_end");
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("chat answered"))).toBe(true);
	});
});
