import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLocalTime } from "../src/shared/local-time.js";
import { createCycle } from "../src/tasks/cycle.js";
import type { TaskFrontmatterV4 } from "../src/tasks/frontmatter.js";
import { renderStandardTaskBody, renderTaskDocument } from "../src/tasks/ledger.js";
import { readTaskLog, resetTaskLogAppenders } from "../src/tasks/log.js";
import { recordVerificationRound } from "../src/tasks/rounds.js";
import { readStoredTask, writeStoredTask } from "../src/tasks/store.js";
import { writeVerificationAttestation } from "../src/tasks/verification.js";
import { createTask } from "../src/tools/task-manage/create.js";
import { closeTask, listTasks, updateTask } from "../src/tools/task-manage/lifecycle.js";
import { endTaskStep } from "../src/tools/task-manage/step-end.js";
import type { TaskManageToolOptions } from "../src/tools/task-manage/types.js";

const CHANNEL_ID = "dm_1";
const SATISFIED_BODY = renderStandardTaskBody({
	title: "Work",
	goal: "Do the work.",
	dod: "- [x] Result is ready",
	manual: "Keep the task scoped.",
});

describe("task tool surface (spec 051, D4)", () => {
	let workspaceDir: string;
	let channelDir: string;
	let tasksDir: string;
	let options: TaskManageToolOptions;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-manage-v4-"));
		channelDir = join(workspaceDir, CHANNEL_ID);
		tasksDir = join(channelDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
		options = { workspaceDir, channelDir, channelId: CHANNEL_ID };
	});

	afterEach(async () => {
		await resetTaskLogAppenders();
		await rm(workspaceDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, fields: Partial<TaskFrontmatterV4> = {}): Promise<void> {
		await writeFile(
			join(tasksDir, `${id}.md`),
			renderTaskDocument({ state: "open", cycle: createCycle("c-1"), ...fields }, SATISFIED_BODY),
		);
	}

	describe("task_create", () => {
		it("creates a one-shot task open, so it starts working instead of waiting for tomorrow", async () => {
			const result = await createTask(options, { id: "work", title: "Work", goal: "G", dod: "- [ ] Done" });
			expect(result).toMatchObject({ state: "open" });
			expect((await readStoredTask(channelDir, "work"))?.fields.state).toBe("open");
		});

		it("records a cadence and a budget without parking the first cycle", async () => {
			await createTask(options, {
				id: "daily",
				title: "Daily",
				goal: "G",
				dod: "- [ ] Done",
				schedule: "0 9 * * *",
				budget: { steps: 12, rounds: 2 },
			});
			const fields = (await readStoredTask(channelDir, "daily"))?.fields;
			expect(fields).toMatchObject({ state: "open", schedule: "0 9 * * *" });
			expect(fields?.budget).toEqual({ steps: 12, rounds: 2 });
		});

		it("keeps ids and DoD strict", async () => {
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

		it("rejects a cadence that would fire faster than the anti-nudge floor", async () => {
			await expect(
				createTask(options, { id: "spin", title: "S", goal: "G", dod: "- [ ] D", schedule: "* * * * *" }),
			).rejects.toThrow(/no more often than/);
		});
	});

	describe("task_update", () => {
		it("edits plan, cadence, budget and verification without touching task state", async () => {
			await writeTask("edit", {
				state: "parked",
				ticket: { kind: "ask", asked: "?", by: "2099-01-01T00:00:00+08:00" },
			});
			await updateTask(options, {
				id: "edit",
				planSteps: [{ id: "P1", text: "Build it" }],
				schedule: "0 9 * * *",
				budget: { steps: 5 },
				verificationRequired: true,
			});
			const document = await readStoredTask(channelDir, "edit");
			expect(document?.body).toContain("P1 Build it");
			expect(document?.fields).toMatchObject({ schedule: "0 9 * * *", verify: "required" });
			expect(document?.fields.budget?.steps).toBe(5);
			// Metadata edits are not lifecycle moves: the park survives untouched (D4).
			expect(document?.fields.state).toBe("parked");
		});

		it("clears a cadence with an empty string", async () => {
			await writeTask("edit", { schedule: "0 9 * * *" });
			await updateTask(options, { id: "edit", schedule: "" });
			expect((await readStoredTask(channelDir, "edit"))?.fields.schedule).toBeUndefined();
		});
	});

	describe("task_step_end", () => {
		const loop = (taskId: string): TaskManageToolOptions => ({ ...options, taskId, cycleId: "c-1" });

		it("is unavailable outside a task loop", async () => {
			await writeTask("work");
			await expect(endTaskStep(options, { outcome: "continue", note: "n" })).rejects.toThrow(
				/only available inside/,
			);
		});

		it("continue keeps the task open and logs the step with the tools it used", async () => {
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
			expect((await readStoredTask(channelDir, "work"))?.fields.cycle?.steps).toBe(1);
		});

		it("park requires a ticket and refuses one that cannot be redeemed", async () => {
			await writeTask("work");
			await expect(endTaskStep(loop("work"), { outcome: "park", note: "n" })).rejects.toThrow(/requires a ticket/);
			await expect(
				endTaskStep(loop("work"), { outcome: "park", note: "n", ticket: { kind: "run", id: "run_ghost" } }),
			).rejects.toThrow(/No run "run_ghost"/);

			await endTaskStep(loop("work"), { outcome: "park", note: "n", ticket: { kind: "time", at: "+2h" } });
			const fields = (await readStoredTask(channelDir, "work"))?.fields;
			expect(fields?.state).toBe("parked");
			expect(fields?.ticket?.by).toBeTruthy();
		});

		it("blocked parks on an ask ticket and always speaks to the user", async () => {
			await writeTask("work");
			await endTaskStep(loop("work"), { outcome: "blocked", note: "n", reason: "Merge to master?" });
			const fields = (await readStoredTask(channelDir, "work"))?.fields;
			expect(fields?.ticket).toMatchObject({ kind: "ask", asked: "Merge to master?" });
			// A task waiting on a person that never says so is the silent dead end tickets exist
			// to prevent, so `blocked` notifies even without an explicit `notify`.
			expect(await readFile(join(tasksDir, ".steer", "work.out.md"), "utf-8")).toContain("Merge to master?");
		});

		it("stays silent unless the step asked to speak", async () => {
			await writeTask("quiet");
			await endTaskStep(loop("quiet"), { outcome: "continue", note: "n" });
			expect(existsSync(join(tasksDir, ".steer", "quiet.out.md"))).toBe(false);
			await endTaskStep(loop("quiet"), { outcome: "continue", note: "n", notify: "报告一下" });
			expect(await readFile(join(tasksDir, ".steer", "quiet.out.md"), "utf-8")).toContain("报告一下");
		});

		it("done archives a one-shot task and parks a recurring one on its next occurrence", async () => {
			await writeTask("once");
			await endTaskStep(loop("once"), { outcome: "done", note: "n", summary: "S", evidence: "E" });
			expect(existsSync(join(tasksDir, "once.md"))).toBe(false);
			expect(await readFile(join(tasksDir, "archive", "once.md"), "utf-8")).toContain("outcome: completed");

			await writeTask("daily", { schedule: "0 9 * * *" });
			await endTaskStep(loop("daily"), { outcome: "done", note: "n", summary: "S", evidence: "E" });
			const fields = (await readStoredTask(channelDir, "daily"))?.fields;
			expect(fields?.state).toBe("parked");
			expect(fields?.ticket?.kind).toBe("schedule");
			expect((await readStoredTask(channelDir, "daily"))?.body).toContain("## 上次结果");
		});

		it("refuses done while acceptance items are unmet", async () => {
			await writeFile(
				join(tasksDir, "open-dod.md"),
				renderTaskDocument(
					{ state: "open", cycle: createCycle("c-1") },
					renderStandardTaskBody({ title: "W", goal: "G", dod: "- [ ] Not yet" }),
				),
			);
			await expect(
				endTaskStep(loop("open-dod"), { outcome: "done", note: "n", summary: "S", evidence: "E" }),
			).rejects.toThrow(/unmet acceptance items/);
		});

		// D7: a cycle of FAIL rounds must not read as verified, and the PASS that unlocks `done`
		// must still bind to the contract on disk at close time — not merely have happened once.
		// Mutation check (2026-09-05): change the gate back to `cycle.rounds === 0` and this goes red.
		it("refuses done on a verify-required task until a passing round has landed", async () => {
			await writeTask("checked", { verify: "required" });
			const attest = (runId: string) =>
				writeVerificationAttestation(channelDir, {
					runId,
					taskId: "checked",
					verdict: "pass",
					checkedAt: formatLocalTime(),
					evidence: "checked",
					workspaceChanged: false,
					verificationStrength: "enforced",
				});
			await expect(
				endTaskStep(loop("checked"), { outcome: "done", note: "n", summary: "S", evidence: "E" }),
			).rejects.toThrow(/requires independent verification/);

			await recordVerificationRound(
				{ channelDir, taskId: "checked", verifyRunId: "run_v1", verdict: "fail", strength: "advisory" },
				4,
			);
			await expect(
				endTaskStep(loop("checked"), { outcome: "done", note: "n", summary: "S", evidence: "E" }),
			).rejects.toThrow(/requires independent verification/);

			await attest("run_v2");
			await recordVerificationRound(
				{ channelDir, taskId: "checked", verifyRunId: "run_v2", verdict: "pass", strength: "advisory" },
				4,
			);
			await expect(
				endTaskStep(loop("checked"), { outcome: "done", note: "n", summary: "S", evidence: "E" }),
			).resolves.toMatchObject({ archived: true });
		});

		// Both close entry points share one gate, so both must refuse a PASS the loop invalidated
		// after the fact. Mutation check: go back to "some round in this cycle passed" and both
		// expectations below resolve instead of rejecting.
		it("refuses both close entry points once the contract changes after the PASS", async () => {
			for (const id of ["edited-step", "edited-close"]) {
				await writeTask(id, { verify: "required" });
				await writeVerificationAttestation(channelDir, {
					runId: `run_${id}`,
					taskId: id,
					verdict: "pass",
					checkedAt: formatLocalTime(),
					evidence: "checked",
					workspaceChanged: false,
					verificationStrength: "enforced",
				});
				await recordVerificationRound(
					{ channelDir, taskId: id, verifyRunId: `run_${id}`, verdict: "pass", strength: "enforced" },
					4,
				);
				// The loop widens the goal after acceptance; the PASS no longer covers what ships.
				const document = await readStoredTask(channelDir, id);
				if (!document) throw new Error(`task ${id} missing`);
				document.body = document.body.replace("Do the work.", "Do the work, and also deploy it.");
				await writeStoredTask(document);
			}

			await expect(
				endTaskStep(loop("edited-step"), { outcome: "done", note: "n", summary: "S", evidence: "E" }),
			).rejects.toThrow(/task contract changed after verification/);
			await expect(
				closeTask(options, { id: "edited-close", outcome: "complete", summary: "S", evidence: "E" }),
			).rejects.toThrow(/task contract changed after verification/);
		});
	});

	describe("task_close", () => {
		it("archives a completed one-shot task and records the close in the loop log", async () => {
			await writeTask("done");
			const result = await closeTask(options, {
				id: "done",
				outcome: "complete",
				summary: "Finished.",
				evidence: "The checked DoD item is present.",
			});
			expect(result).toMatchObject({ archived: true });
			expect(existsSync(join(tasksDir, "done.md"))).toBe(false);
			// The loop log travels with its contract, so an archived task stays inspectable.
			expect(existsSync(join(tasksDir, "done.jsonl"))).toBe(false);
			const archivedLog = await readFile(join(tasksDir, "archive", "done.jsonl"), "utf-8");
			expect(archivedLog).toContain('"kind":"close"');
		});

		it("skips one recurring occurrence onto the next, and refuses skip for one-shot work", async () => {
			await writeTask("weekly", { schedule: "0 9 * * 1" });
			const skipped = await closeTask(options, { id: "weekly", outcome: "skip", reason: "source missing" });
			expect(skipped.state).toBe("parked");
			const document = await readStoredTask(channelDir, "weekly");
			expect(document?.fields.ticket?.kind).toBe("schedule");
			// A skip must not fabricate completion evidence for an occurrence that did not run.
			expect(document?.body).toContain("跳过");

			await writeTask("once");
			await expect(closeTask(options, { id: "once", outcome: "skip", reason: "x" })).rejects.toThrow(/one-shot/);
		});

		it("deletes only the closed task's own events, not a sibling whose id extends it by a dot", async () => {
			// "v1" is a string prefix of "v1.2-release"; ids may contain dots, so cleanup must match
			// the parsed id exactly rather than `startsWith("task.<channel>.v1.")`.
			await writeTask("v1");
			await writeTask("v1.2-release");
			const eventsDir = join(workspaceDir, "events");
			await mkdir(eventsDir, { recursive: true });
			const own = join(eventsDir, "task.dm_1.v1.checkin.json");
			const sibling = join(eventsDir, "task.dm_1.v1.2-release.checkin.json");
			const body = JSON.stringify({ type: "periodic", channelId: CHANNEL_ID, text: "c", schedule: "0 * * * *" });
			await writeFile(own, body);
			await writeFile(sibling, body);

			await closeTask(options, { id: "v1", outcome: "complete", summary: "S", evidence: "E" });
			expect(existsSync(own)).toBe(false);
			expect(existsSync(sibling)).toBe(true);
		});

		it("cancels into a cancelled archive", async () => {
			await writeTask("gone", { schedule: "0 9 * * 1" });
			await closeTask(options, { id: "gone", outcome: "cancel", reason: "No longer needed." });
			expect(await readFile(join(tasksDir, "archive", "gone.md"), "utf-8")).toContain("outcome: cancelled");
		});
	});

	describe("task_list", () => {
		it("summarises state, park and cycle spend for each live task", async () => {
			await writeTask("open");
			await writeTask("waiting", {
				state: "parked",
				ticket: { kind: "ask", asked: "merge?", by: "2099-01-01T00:00:00+08:00" },
			});
			const result = await listTasks(options);
			expect(result.tasks?.map((task) => task.id).sort()).toEqual(["open", "waiting"]);
			expect(result.tasks?.find((task) => task.id === "waiting")?.ticket).toContain("merge?");
		});
	});
});
