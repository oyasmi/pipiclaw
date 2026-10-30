import { existsSync, readFileSync, renameSync, utimesSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventHistoryAction, EventHistoryRecord } from "../../../src/events/types.js";
import { readActiveTasks } from "../../../src/tasks/contract.js";
import { readTaskLog } from "../../../src/tasks/loop-log.js";
import { readStoredTask } from "../../../src/tasks/store.js";
import {
	createDeterministicHarness,
	type DeterministicHarness,
	reply,
	writeWorkspaceFile,
} from "../../support/runtime-harness.js";
import { waitFor, waitForFileContent } from "../helpers/wait.js";

/**
 * Spec 064: a task runs in the task lane, never in a channel's queue. These cases prove the
 * mechanism across modules — lane ↔ runner ↔ session ↔ tools ↔ managers ↔ delivery — with the real
 * bootstrap and a scripted model; the matrices (slots, guards, derivation) live in unit tests.
 */
describe("E2E deterministic: the task lane", () => {
	let harness: DeterministicHarness;
	const taskId = "e2e-det-task";
	afterEach(async () => {
		await harness.shutdown();
	});

	const tasksDir = () => join(harness.deskDir, "tasks");
	const archived = () => join(tasksDir(), "archive", `${taskId}.md`);
	const lane = () => harness.runtime.taskLane;

	/** Chat creates the task, exactly as a user would ask for it; the lane has not run yet. */
	async function seedTask(): Promise<void> {
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
		await harness.sendUserMessage("seed-task");
		expect((await readStoredTask(harness.deskDir, taskId))?.fields.state).toBe("queued");
	}

	const stepOf = (n: number) => (r: { isMainTurn: boolean; lastUserText: string }) =>
		r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${taskId} #${n}]`);

	it("T-lane-1: a chat message is answered while a task step is in flight — the task never holds the chat", async () => {
		// The incident: a long task step (a delegation, a stuck tool) used to occupy the channel queue,
		// and the user's question waited behind it. Mutation check (2026-10-28): return the channel's own
		// runner from `createTaskRunner` in bootstrap (the step then runs in the chat's session with the
		// chat's tools) and the task-tool assertions on the held step's request fail.
		harness = await createDeterministicHarness();
		await seedTask();
		harness.model.script.route({
			name: "chat",
			when: (r) => r.isMainTurn && r.lastUserText.includes("CHAT_MARKER"),
			respond: [reply.text("chat answered")],
		});
		harness.model.script.route({
			name: "step",
			when: stepOf(1),
			respond: [
				reply.toolCall("task_report", { text: "done" }),
				reply.toolCall("task_close", { id: taskId, outcome: "complete", note: "done" }),
				reply.text("unused"),
			],
		});
		const gate = harness.model.script.hold({ when: stepOf(1) });

		await lane().runOnce();
		const request = await gate.arrived;
		// The step runs in its own session with the task-session tools, apart from the chat's.
		expect(request.tools).toContain("task_close");
		expect(request.tools).toContain("task_report");
		expect(request.tools).not.toContain("task_create");
		expect(request.lastUserText).toContain("<task_contract");

		await harness.sendUserMessage("顺便问个别的 CHAT_MARKER");
		expect(harness.deliveries.some((d) => (d.text ?? "").includes("chat answered"))).toBe(true);
		// The step is still held: the chat did not wait for it, and it did not wait for the chat.
		expect(existsSync(archived())).toBe(false);
		const chatRequest = harness.mainTurnRequests().find((r) => r.lastUserText.includes("CHAT_MARKER"));
		expect(chatRequest?.tools).toContain("task_create");
		expect(chatRequest?.tools).not.toContain("task_report");

		gate.release();
		await waitFor("the task to be archived", () => existsSync(archived()), { intervalMs: 25 });
		expect(readFileSync(join(harness.conversationDir, "context.jsonl"), "utf8")).not.toContain("TASK_STEP");
	});

	it("T-lane-2: a bound result wakes the task in its own session — the chat is never asked", async () => {
		// Mutation check (2026-10-28): drop `onTaskInput` from the job runtime wiring in bootstrap and
		// raise the lane's sleep ceiling; the second step never starts and the archive wait times out.
		harness = await createDeterministicHarness({ services: true });
		await seedTask();
		harness.model.script.route({
			name: "step-1",
			when: stepOf(1),
			respond: [
				reply.toolCall("bash", { command: "sleep 0.5; echo JOB_RESULT_77", async: true }),
				reply.text("job started; waiting"),
			],
		});
		harness.model.script.route({
			name: "step-2",
			when: stepOf(2),
			respond: [
				reply.toolCall("task_report", { text: "result checked" }),
				reply.toolCall("task_close", { id: taskId, outcome: "complete", note: "result checked" }),
			],
		});

		await waitFor("the task to be archived", () => existsSync(archived()), { intervalMs: 25 });

		const log = await readTaskLog(harness.deskDir, taskId);
		expect(log.filter((r) => r.kind === "step_end").map((r) => (r.kind === "step_end" ? r.next : ""))).toEqual([
			"work",
			"closed",
		]);
		expect(log.map((r) => r.kind)).toContain("settle");
		const second = harness.mainTurnRequests().find((r) => r.lastUserText.includes(`[TASK_STEP:${taskId} #2]`));
		expect(second?.lastUserText).toMatch(/<task_inputs>[\s\S]*JOB_RESULT_77/);
		// The second step carries only what is new: the contract came with the first.
		expect(second?.lastUserText).not.toContain("<task_contract");
		// The chat saw neither the job's completion nor the task's steps.
		const chatRequests = harness.mainTurnRequests().filter((r) => r.tools.includes("task_create"));
		expect(chatRequests.every((r) => r.lastUserText.includes("seed-task") || r.matchedRoute === "create")).toBe(true);
		expect(JSON.stringify(harness.mainTurnRequests().map((r) => r.lastUserText))).not.toContain("[JOB:");
	});

	it("T-lane-3: the chat manages a running task — a message joins the step, a pause stops it, a resume goes on", async () => {
		// Mutation check (2026-10-28): make `LaneControl.message` always record for the next step
		// instead of calling `queueSteer`, and the MSG_MARK assertion on the step's second provider
		// request fails; make `pause` skip `abortStep` and the step runs to its end.
		harness = await createDeterministicHarness();
		await seedTask();
		harness.model.script.route({
			name: "step-1",
			// After the message joins the step, the last user turn is the message itself.
			when: (r) => stepOf(1)(r) || (r.isMainTurn && r.lastUserText.includes("MSG_MARK")),
			respond: [reply.toolCall("bash", { command: "echo working" }), reply.text("step one done")],
		});
		harness.model.script.route({
			name: "step-2",
			when: stepOf(2),
			respond: [reply.toolCall("bash", { command: "echo more" }), reply.text("unused")],
		});
		harness.model.script.route({
			name: "step-3",
			when: stepOf(3),
			respond: [
				reply.toolCall("task_report", { text: "done" }),
				reply.toolCall("task_close", { id: taskId, outcome: "complete", note: "done" }),
			],
		});
		const first = harness.model.script.hold({ when: stepOf(1) });
		await lane().runOnce();
		await first.arrived;

		const sent = await harness.runCommand("tasks", `msg ${taskId} MSG_MARK 请多检查一遍`);
		expect(sent).toContain(taskId);
		first.release();
		const second = harness.model.script.hold({ when: stepOf(2) });
		await second.arrived;
		// The message reached the step that was running when it was sent, and is not repeated to the next one.
		const stepOne = harness.mainTurnRequests().filter((r) => r.matchedRoute === "step-1");
		expect(JSON.stringify(stepOne.at(-1)?.messages)).toContain("MSG_MARK");
		expect(harness.mainTurnRequests().at(-1)?.lastUserText).not.toContain("MSG_MARK");

		await harness.runCommand("tasks", `pause ${taskId}`);
		second.release();
		await waitFor(
			"the paused step to be recorded",
			async () => (await readTaskLog(harness.deskDir, taskId)).some((r) => r.kind === "step_end" && r.seq === 2),
			{ intervalMs: 25 },
		);
		const ended = (await readTaskLog(harness.deskDir, taskId)).find((r) => r.kind === "step_end" && r.seq === 2);
		expect(ended).toMatchObject({ result: "aborted", next: "paused" });
		expect((await readStoredTask(harness.deskDir, taskId))?.fields.state).toBe("paused");

		await harness.runCommand("tasks", `resume ${taskId}`);
		await lane().runOnce();
		await waitFor("the task to be archived", () => existsSync(archived()), { intervalMs: 25 });
		const third = harness.mainTurnRequests().find((r) => r.lastUserText.includes(`#3]`));
		expect(third?.lastUserText).toContain("恢复");
	});

	it("T-lane-4: the real event watcher spawns instances the lane drives and archives; replay and overlap stay idempotent", async () => {
		// Catches bootstrap disconnecting watcher → spawner → lane. A direct spawner call could not
		// catch that wiring fault. Mutation check (2026-10-28): drop `spawnTask` from the watcher options in
		// bootstrap and no instance is ever created — the held step never arrives and the case fails.
		harness = await createDeterministicHarness({ services: true, events: true });
		const id = "weekly-20200106-0900";
		const historyPath = join(harness.homeDir, "state", "events", "history.jsonl");
		const event = (at: string) =>
			JSON.stringify({
				type: "one-shot",
				channelId: harness.channelId,
				at,
				task: { title: "周报", goal: "写周报", dod: "- [x] 已写", items: [{ text: "整理" }] },
			});
		const writeOccurrence = (at: string) => {
			// Publish an overdue persisted definition atomically, preserving its pre-boot mtime.
			const pending = writeWorkspaceFile(harness, "events/weekly.pending", event(at));
			utimesSync(pending, new Date(at), new Date(at));
			renameSync(pending, join(harness.deskDir, "events", "weekly.json"));
		};
		const recorded = (action: EventHistoryAction, count: number) =>
			waitForFileContent(
				historyPath,
				(content) =>
					content
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as EventHistoryRecord)
						.filter(
							(record) => record.eventName === "weekly" && record.action === action && record.result === "ok",
						).length === count,
				{ timeoutMs: 5_000, intervalMs: 25 },
			);
		for (const instance of [id, "weekly-20200113-0900"]) {
			harness.model.script.route({
				name: `step-${instance}`,
				when: (r) => r.isMainTurn && r.lastUserText.includes(`[TASK_STEP:${instance} #1]`),
				respond: [
					reply.toolCall("edit", {
						path: join(tasksDir(), `${instance}.md`),
						oldText: "- [ ] W1 整理",
						newText: "- [x] W1 整理",
					}),
					reply.toolCall("task_report", { text: "周报已写" }),
					reply.toolCall("task_close", { id: instance, outcome: "complete", note: "周报已写" }),
				],
			});
		}
		const gate = harness.model.script.hold({ when: (r) => r.lastUserText.includes(`[TASK_STEP:${id} #1]`) });
		try {
			writeOccurrence("2020-01-06T09:00:00+08:00");
			const request = await gate.arrived;
			expect(request.tools).toContain("task_close");
			const entry = (await readActiveTasks(tasksDir())).find((e) => e.id === id);
			expect(entry?.fields.origin).toBe("weekly");
			await recorded("enqueued", 1);
			writeOccurrence("2020-01-06T09:00:00+08:00");
			await recorded("skipped", 1);
			writeOccurrence("2020-01-13T09:00:00+08:00");
			// The previous instance is still running (held): the new occurrence is skipped and the user told.
			await harness.waitForDelivery((d) => d.method === "sendPlain" && (d.text ?? "").includes(`/tasks show ${id}`));
			await recorded("skipped", 2);
			expect((await readActiveTasks(tasksDir())).map((e) => e.id)).toEqual([id]);
		} finally {
			gate.release();
		}
		await waitFor("the first instance to be archived", () => existsSync(join(tasksDir(), "archive", `${id}.md`)), {
			intervalMs: 25,
		});
		expect((await readTaskLog(harness.deskDir, id, { kinds: ["close"] })).map((r) => r.kind)).toEqual(["close"]);
		writeOccurrence("2020-01-06T09:00:00+08:00");
		await recorded("skipped", 3); // An archived instance also suppresses its own replay.
		const nextId = "weekly-20200113-0900";
		writeOccurrence("2020-01-13T09:00:00+08:00"); // Completed predecessor no longer blocks it.
		await waitFor("the next instance to be archived", () => existsSync(join(tasksDir(), "archive", `${nextId}.md`)), {
			intervalMs: 25,
		});
		await recorded("enqueued", 2);
		const count = harness.mainTurnRequests().length;
		await harness.restart();
		expect(harness.mainTurnRequests()).toHaveLength(count);
	});
});
