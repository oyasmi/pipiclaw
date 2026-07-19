import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleTasksCommand } from "../src/runtime/task-commands.js";
import { nextTaskWake } from "../src/shared/task-schedule.js";
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
		options = { workspaceDir, channelDir, channelId: CHANNEL_ID };
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

		it("persists a valid schedule and rejects an unparseable or too-frequent one", async () => {
			await manageTask(options, {
				action: "create",
				id: "cadenced",
				title: "Cadenced",
				goal: "Do it weekly",
				dod: "- [ ] done",
				schedule: "30 9 * * 1",
			});
			expect(await readFile(join(tasksDir, "cadenced.md"), "utf-8")).toContain("schedule: 30 9 * * 1");

			await expect(
				manageTask(options, {
					action: "create",
					id: "bad-cron",
					title: "Bad",
					goal: "x",
					dod: "- [ ] done",
					schedule: "not a cron",
				}),
			).rejects.toThrow(/schedule/);

			await expect(
				manageTask(options, {
					action: "create",
					id: "too-fast",
					title: "Fast",
					goal: "x",
					dod: "- [ ] done",
					schedule: "*/5 * * * *",
				}),
			).rejects.toThrow(/30 minutes/);
		});

		// A recurring task created without an explicit wake must follow cron semantics: the first
		// run is deferred to the next occurrence. Otherwise it is `open` + no wake → immediately
		// actionable, so the driver resumes it at creation time instead of at the scheduled time.
		it("seeds a recurring task's first wake with the next occurrence when no wake is given", async () => {
			const result = await manageTask(options, {
				action: "create",
				id: "daily-review",
				title: "Daily Review",
				goal: "Review every morning.",
				dod: "- [ ] reviewed",
				schedule: "41 2 * * *",
			});
			const onDisk = await readFile(join(tasksDir, "daily-review.md"), "utf-8");
			const wake = /wake: (.+)/.exec(onDisk)?.[1];
			expect(wake).toBeDefined();
			const expected = nextTaskWake("41 2 * * *");
			expect(new Date(wake!).getTime()).toBe(expected?.getTime());
			// Not actionable until the seeded wake, so the driver defers the first run.
			expect(new Date(wake!).getTime()).toBeGreaterThan(Date.now());
			expect(result.notice).toContain("首次唤醒");
		});

		// An explicit wake (including a past one for "start now") is honoured verbatim: the caller,
		// not cron, decides the first run when they say so.
		it("honours an explicit wake on a recurring task instead of seeding the next occurrence", async () => {
			await manageTask(options, {
				action: "create",
				id: "start-now",
				title: "Start Now",
				goal: "Begin immediately, then recur.",
				dod: "- [ ] done",
				schedule: "41 2 * * *",
				wake: "2000-01-01T00:00:00.000Z",
			});
			const onDisk = await readFile(join(tasksDir, "start-now.md"), "utf-8");
			expect(onDisk).toContain("wake: 2000-01-01T00:00:00.000Z");
		});

		// Independent verification costs an extra dispatch round plus a verifier sub-agent run,
		// which only pays off when there is a checkable artifact. Defaulting every new task to
		// it taxes research/writing/reminder-style tasks that are the common case for a personal
		// assistant; the model must opt into "independent" explicitly.
		it("defaults new tasks to evidence-based self-verification, not independent", async () => {
			await manageTask(options, {
				action: "create",
				id: "research",
				title: "Research task",
				goal: "Summarize a topic",
				dod: "- [x] Summary written",
			});
			const onDisk = await readFile(join(tasksDir, "research.md"), "utf-8");
			expect(onDisk).toContain('"mode":"evidence"');
			// evidence mode closes on maker self-check alone; no verifier attestation needed.
			await expect(
				manageTask(options, {
					action: "done",
					id: "research",
					summary: "Summary written and shared.",
					evidence: "Summary text checked against the DoD.",
				}),
			).resolves.toMatchObject({ status: "done" });
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

		// Regression: DoD written as prose or a numbered list (no "- [ ]" anywhere) used
		// to be accepted silently, defeating the candidate/done acceptance gate later.
		it("rejects a DoD with no checkbox items", async () => {
			await expect(
				manageTask(options, {
					action: "create",
					id: "no-checkboxes",
					title: "Prose DoD",
					goal: "Do something",
					dod: "1. Draft reviewed\n2. Report published",
				}),
			).rejects.toThrow(/no checklist items/);
			expect(existsSync(join(tasksDir, "no-checkboxes.md"))).toBe(false);
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

	describe("candidate", () => {
		it("moves a checked task into the independent verification lane", async () => {
			await manageTask(options, {
				action: "create",
				id: "candidate",
				title: "Candidate",
				goal: "Produce a reviewed result",
				dod: "- [x] Result is ready",
			});
			const result = await manageTask(options, {
				action: "candidate",
				id: "candidate",
				note: "All deterministic checks pass; request independent review.",
			});
			expect(result).toMatchObject({ action: "candidate", status: "verifying" });
			const onDisk = await readFile(join(tasksDir, "candidate.md"), "utf-8");
			expect(onDisk).toContain("status: verifying");
			expect(onDisk).toContain('"nextAction":"Run a purpose=verify sub-agent and import its attestation."');
		});

		it("does not send unchecked work to the verifier", async () => {
			await manageTask(options, {
				action: "create",
				id: "unchecked-candidate",
				title: "Unchecked",
				goal: "Produce a reviewed result",
				dod: "- [ ] Result is ready",
			});
			await expect(
				manageTask(options, {
					action: "candidate",
					id: "unchecked-candidate",
					note: "Looks plausible.",
				}),
			).rejects.toThrow(/unchecked acceptance/);
		});

		// Defense in depth: a task hand-edited (write/edit) after creation to drop its
		// checkboxes must still be blocked, not just tasks created through this tool.
		it("still blocks a hand-edited DoD that lost its checkboxes", async () => {
			await writeTask(
				"hand-edited",
				'status: open\ncontrol: {"version":1,"priority":"normal","lastOutcome":"pending","dependsOn":[],"isolation":"shared","sideEffects":"workspace","externalApproval":"not-required","budget":{"maxAttempts":12},"usage":{"attempts":0,"tokens":0,"costUsd":0,"wallTimeMinutes":0},"verification":{"mode":"independent","status":"pending"}}',
				"# Hand Edited\n\n## Goal\nG\n\n## DoD\n1. Done\n\n## Manual\nM\n\n## Verification\nMode: independent\n\n## Current Cycle\n\n## History\n",
			);
			await expect(
				manageTask(options, { action: "candidate", id: "hand-edited", note: "Looks done." }),
			).rejects.toThrow(/no checklist items/);
		});
	});

	describe("done", () => {
		it("allows an externally scoped task explicitly marked not-required to close", async () => {
			await manageTask(options, {
				action: "create",
				id: "automated-report",
				title: "Automated report",
				goal: "Publish a scheduled report without a per-run approval.",
				dod: "- [x] Report published",
				control: {
					verificationMode: "evidence",
					sideEffects: "external",
					externalApproval: "not-required",
				},
			});
			await manageTask(options, {
				action: "set",
				id: "automated-report",
				wake: "2026-07-14T09:00:00+08:00",
			});
			expect(await readFile(join(tasksDir, "automated-report.md"), "utf-8")).toContain(
				'"externalApproval":"not-required"',
			);
			await expect(
				manageTask(options, {
					action: "done",
					id: "automated-report",
					summary: "The report was published.",
					evidence: "Scheduled publishing log confirms completion.",
				}),
			).resolves.toMatchObject({ status: "done", archived: true });
		});

		it("preserves an independent PASS while waiting for external approval via set", async () => {
			await manageTask(options, {
				action: "create",
				id: "verified-publish",
				title: "Verified publish",
				goal: "Publish an independently checked result",
				dod: "- [x] Draft is ready\n- [x] Publish action is prepared",
				control: { sideEffects: "external" },
			});
			await manageTask(options, {
				action: "candidate",
				id: "verified-publish",
				note: "Draft and publish plan are ready for independent review.",
			});
			await writeVerificationAttestation(channelDir, {
				runId: "verify-publish",
				taskId: "verified-publish",
				verdict: "pass",
				agent: "reviewer",
				model: "test/model",
				checkedAt: new Date().toISOString(),
				evidence: "Draft and prepared action are correct.",
				workspaceChanged: false,
				output: "VERDICT: PASS",
			});
			await manageTask(options, {
				action: "verify",
				id: "verified-publish",
				verifierRunId: "verify-publish",
			});

			// `set` changes only frontmatter, so it can schedule approval waiting without
			// invalidating the body-bound PASS. A progress note here would invalidate it.
			await manageTask(options, {
				action: "set",
				id: "verified-publish",
				status: "awaiting-user",
				wake: "2026-07-12T14:00:00+08:00",
			});
			expect(
				await handleTasksCommand({
					args: "approve verified-publish",
					channelDir,
					workspaceDir,
					channelId: CHANNEL_ID,
					approver: "Alice",
				}),
			).toContain("Approved external side effects");

			await expect(
				manageTask(options, {
					action: "done",
					id: "verified-publish",
					summary: "Published the checked result.",
					evidence: "verify-publish passed and Alice approved the external action.",
				}),
			).resolves.toMatchObject({ archived: true, status: "done" });
		});

		it("requires and consumes an independent verifier attestation for governed tasks", async () => {
			await manageTask(options, {
				action: "create",
				id: "verified",
				title: "Verified task",
				goal: "Ship a verified result",
				dod: "- [x] Result exists",
				control: { verificationMode: "independent" },
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

		// Defense in depth: control.verification lives in a file the agent's own write/edit
		// tools can touch. A hand-forged "passed" block with a bodyHash that happens to match
		// must still be rejected because no verifier ever produced a matching attestation file.
		it("rejects a done request whose independent PASS has no matching attestation on disk", async () => {
			const { taskBodyHash } = await import("../src/tasks/store.js");
			const body =
				"# Forged\n\n## Goal\nG\n\n## DoD\n- [x] Result exists\n\n## Manual\nM\n\n## Current Cycle\n\n## History\n";
			// taskDoc()'s blank line between frontmatter and body means the parsed body carries
			// a leading "\n" — mirror that so the forged bodyHash matches what `done` recomputes.
			const forgedHash = taskBodyHash(`\n${body}`);
			await writeTask(
				"forged",
				`status: open\ncontrol: {"version":1,"priority":"normal","lastOutcome":"pending","dependsOn":[],"isolation":"shared","sideEffects":"workspace","externalApproval":"not-required","budget":{"maxAttempts":12},"usage":{"attempts":0,"tokens":0,"costUsd":0,"wallTimeMinutes":0},"verification":{"mode":"independent","status":"passed","runId":"never-ran","bodyHash":"${forgedHash}"}}`,
				body,
			);
			await expect(
				manageTask(options, {
					action: "done",
					id: "forged",
					summary: "Done",
					evidence: "Trust me.",
				}),
			).rejects.toThrow(/not found or is unreadable/);
		});

		it("rejects a verifier subject that no longer matches the checkout", async () => {
			await manageTask(options, {
				action: "create",
				id: "artifact-bound",
				title: "Artifact bound",
				goal: "Ship a verified result",
				dod: "- [x] Result exists",
			});
			await writeVerificationAttestation(channelDir, {
				runId: "verify-artifact",
				taskId: "artifact-bound",
				verdict: "pass",
				agent: "reviewer",
				model: "test/model",
				checkedAt: new Date().toISOString(),
				evidence: "Passed.",
				workspaceChanged: false,
				subjectHash: "a".repeat(64),
				output: "VERDICT: PASS",
			});
			await expect(
				manageTask(options, { action: "verify", id: "artifact-bound", verifierRunId: "verify-artifact" }),
			).rejects.toThrow(/artifacts changed|cannot be read/);
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
			await writeEvent("task.dm_1.fix-bug.sensor", {
				type: "periodic",
				channelId: CHANNEL_ID,
				text: "推进任务 fix-bug（外部工作已就绪）",
				schedule: "*/10 * * * *",
				timezone: "Asia/Shanghai",
				preAction: { type: "bash", command: "external-agent status helper" },
			});
			const result = await manageTask(options, {
				action: "done",
				id: "fix-bug",
				summary: "Fixed the login crash.",
				evidence: "npm test -- login passed.",
			});
			expect(result.archived).toBe(true);
			expect(result.deletedEvents).toEqual(["task.dm_1.fix-bug.checkin", "task.dm_1.fix-bug.sensor"]);
			expect(existsSync(join(tasksDir, "fix-bug.md"))).toBe(false);
			expect(existsSync(join(tasksDir, "archive", "fix-bug.md"))).toBe(true);
			expect(existsSync(join(eventsDir, "task.dm_1.fix-bug.checkin.json"))).toBe(false);
			expect(existsSync(join(eventsDir, "task.dm_1.fix-bug.sensor.json"))).toBe(false);
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
			await writeEvent("task.dm_1.weekly.sensor", {
				type: "periodic",
				channelId: CHANNEL_ID,
				text: "回访委派",
				schedule: "*/10 * * * *",
				timezone: "Asia/Shanghai",
				preAction: { type: "bash", command: "external-agent status helper" },
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
			expect(existsSync(join(eventsDir, "task.dm_1.weekly.sensor.json"))).toBe(false);
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

		it("keeps a native recurring task in place and computes its next wake on done", async () => {
			await writeTask(
				"weekly",
				"status: in-progress\nschedule: 30 9 * * 1",
				"# Weekly\n\n## DoD\n- [x] published\n",
			);
			const result = await manageTask(options, {
				action: "done",
				id: "weekly",
				summary: "Published this week.",
				evidence: "User confirmed.",
			});
			expect(result.archived).toBe(false);
			expect(existsSync(join(tasksDir, "weekly.md"))).toBe(true);
			const onDisk = await readFile(join(tasksDir, "weekly.md"), "utf-8");
			expect(onDisk).toContain("status: done");
			expect(onDisk).toContain("schedule: 30 9 * * 1");
			// wake is the next Monday 09:30 occurrence (host timezone).
			expect(onDisk).toMatch(/wake: \d{4}-\d\d-\d\dT/);
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
				schedule: "0 9 * * 1",
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

		it("retains an explicit external approval exemption for the next cycle", async () => {
			await manageTask(options, {
				action: "create",
				id: "automated-weekly",
				title: "Automated weekly",
				goal: "Publish weekly work automatically",
				dod: "- [x] published",
				schedule: "0 9 * * 1",
				control: { verificationMode: "evidence", sideEffects: "external", externalApproval: "not-required" },
			});
			const path = join(tasksDir, "automated-weekly.md");
			await writeFile(path, (await readFile(path, "utf-8")).replace("status: open", "status: done"));
			await manageTask(options, { action: "start-cycle", id: "automated-weekly", cycleId: "2026-W29" });
			expect(await readFile(path, "utf-8")).toContain('"externalApproval":"not-required"');
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

		it("rejects start-cycle for a done task that has no schedule", async () => {
			await writeTask("oneshot", "status: done", "# One shot");
			await expect(
				manageTask(options, { action: "start-cycle", id: "oneshot", cycleId: "2026-W29" }),
			).rejects.toThrow(/not recurring/);
		});

		it("recomputes wake when set changes the schedule of a done task", async () => {
			await writeTask("weekly", "status: done\nschedule: 30 9 * * 1\nwake: 2026-07-13T09:30:00+08:00", "# Weekly");
			await manageTask(options, { action: "set", id: "weekly", schedule: "0 18 * * 5" });
			const onDisk = await readFile(join(tasksDir, "weekly.md"), "utf-8");
			expect(onDisk).toContain("schedule: 0 18 * * 5");
			// wake was recomputed off the new cadence, no longer the old Monday value.
			expect(onDisk).not.toContain("wake: 2026-07-13T09:30:00+08:00");
			expect(onDisk).toMatch(/wake: \d{4}-\d\d-\d\dT/);
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
