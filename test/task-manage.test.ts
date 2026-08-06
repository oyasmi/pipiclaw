import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLocalTime } from "../src/shared/local-time.js";
import { nextTaskWake } from "../src/shared/task-schedule.js";
import { workspaceSubjectHash } from "../src/tasks/artifact-subject.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import { renderStandardTaskBody } from "../src/tasks/ledger.js";
import { readStoredTask } from "../src/tasks/store.js";
import { writeVerificationAttestation } from "../src/tasks/verification.js";
import { parseAction } from "../src/tools/task-manage/schema.js";
import { manageTask, type TaskManageRequest, type TaskManageToolOptions } from "../src/tools/task-manage.js";

const CHANNEL_ID = "dm_1";
const STANDARD_BODY = renderStandardTaskBody({
	title: "Work",
	goal: "Do the work.",
	dod: "- [x] Result is ready",
	manual: "Keep the task scoped.",
});

function doc(front: string, body = STANDARD_BODY): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("task_manage v2", () => {
	let workspaceDir: string;
	let channelDir: string;
	let tasksDir: string;
	let subjectDir: string | undefined;
	let options: TaskManageToolOptions;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-manage-v2-"));
		channelDir = join(workspaceDir, CHANNEL_ID);
		tasksDir = join(channelDir, "tasks");
		await mkdir(join(tasksDir, "archive"), { recursive: true });
		options = { workspaceDir, channelDir, channelId: CHANNEL_ID };
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
		if (subjectDir) await rm(subjectDir, { recursive: true, force: true });
	});

	async function writeTask(id: string, front: string, body = STANDARD_BODY): Promise<void> {
		await writeFile(join(tasksDir, `${id}.md`), doc(front, body));
	}

	async function createOneShot(id = "work", control?: TaskManageRequest["control"]): Promise<void> {
		await manageTask(options, {
			action: "create",
			id,
			title: "Work",
			goal: "Do the work.",
			dod: "- [x] Result is ready",
			control,
		});
	}

	it("creates one-shot active work with a v2 control and no approval surface", async () => {
		const result = await manageTask(options, {
			action: "create",
			id: "work",
			title: "Work",
			goal: "Do the work.",
			dod: "- [ ] Result is ready",
			control: { verificationRequired: false, priority: "high" },
		});
		expect(result).toMatchObject({ action: "create", status: "active" });
		const stored = await readFile(join(tasksDir, "work.md"), "utf-8");
		expect(stored).toContain("status: active");
		expect(stored).toContain('"version":2');
		expect(stored).toMatch(/"provenance":\{"createdAt":"[^"]+"\}/);
		expect(stored).not.toMatch(/sideEffects|externalApproval|approvalBy|approvedAt|approvalBodyHash/);
	});

	it("creates recurring work sleeping with its first occurrence and no dispatch", async () => {
		const result = await manageTask(options, {
			action: "create",
			id: "weekly",
			title: "Weekly",
			goal: "Run weekly.",
			dod: "- [ ] Result is ready",
			schedule: "0 9 * * 1",
		});
		const stored = await readFile(join(tasksDir, "weekly.md"), "utf-8");
		expect(result.status).toBe("sleeping");
		expect(stored).toContain("status: sleeping");
		expect(stored).toContain(`wake: ${formatLocalTime(nextTaskWake("0 9 * * 1")!)}`);
		expect(stored).not.toContain('"cycleId"');
	});

	it("rejects sleeping for a one-shot task and rejects retired action names", async () => {
		await expect(
			manageTask(options, {
				action: "create",
				id: "bad",
				title: "Bad",
				goal: "G",
				dod: "- [ ] D",
				status: "sleeping",
			}),
		).rejects.toThrow(/one-shot/);
		expect(() => parseAction("approve")).toThrow(/Unsupported task action/);
	});

	it("progresses active work and normalizes a future wake to waiting", async () => {
		await createOneShot("progress");
		const futureWake = formatLocalTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		const result = await manageTask(options, {
			action: "progress",
			id: "progress",
			note: "Build complete; wait for the scheduled check.",
			wake: futureWake,
		});
		expect(result.status).toBe("waiting");
		const stored = await readStoredTask(channelDir, "progress");
		expect(stored?.fields).toMatchObject({ status: "waiting", wake: futureWake });
		expect(stored?.fields.control?.waitingFor).toBe("time");
	});

	it("requests verification through a durable callback and parks on a verification signal", async () => {
		await createOneShot("verify-me", { verificationRequired: true });
		const dispatched: string[] = [];
		const result = await manageTask(
			{
				...options,
				dispatchVerification: async (id) => {
					dispatched.push(id);
					return true;
				},
			},
			{ action: "request-verification", id: "verify-me", note: "All acceptance checks are complete." },
		);
		expect(result).toMatchObject({ action: "request-verification", status: "waiting" });
		expect(dispatched).toEqual(["verify-me"]);
		const stored = await readStoredTask(channelDir, "verify-me");
		expect(stored?.fields).toMatchObject({ status: "waiting", wake: undefined });
		expect(stored?.fields.control).toMatchObject({ waitingFor: "verification", verification: { status: "pending" } });
	});

	it("rolls verification back to active when the checker cannot be enqueued", async () => {
		await createOneShot("retry-verification", { verificationRequired: true });
		await expect(
			manageTask(
				{ ...options, dispatchVerification: async () => false },
				{ action: "request-verification", id: "retry-verification", note: "Request review." },
			),
		).rejects.toThrow(/restored to active/);
		const stored = await readStoredTask(channelDir, "retry-verification");
		expect(stored?.fields.status).toBe("active");
		expect(stored?.fields.control?.waitingFor).toBeUndefined();
	});

	it("imports a real verifier attestation and then completes without approval", async () => {
		await createOneShot("verified", { verificationRequired: true });
		const withVerifier = { ...options, dispatchVerification: async () => true };
		await manageTask(withVerifier, {
			action: "request-verification",
			id: "verified",
			note: "Ready for independent verification.",
		});
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "run-1",
			taskId: "verified",
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists and the test command passed.",
			workspaceChanged: false,
		});
		const verified = await manageTask(withVerifier, {
			action: "verify",
			id: "verified",
			verifierRunId: attestation.runId,
		});
		expect(verified.status).toBe("active");
		const completed = await manageTask(options, {
			action: "complete",
			id: "verified",
			summary: "Result is complete.",
			evidence: "Independent verifier run-1 passed.",
		});
		expect(completed).toMatchObject({ action: "complete", archived: true });
		const archive = join(tasksDir, "archive", "verified.md");
		expect(existsSync(archive)).toBe(true);
		const archived = await readFile(archive, "utf-8");
		expect(archived).toContain("outcome: completed");
		expect(archived).not.toContain("status:");
	});

	it("anchors completion subject freshness to the durable attestation", async () => {
		subjectDir = await mkdtemp(join(tmpdir(), "task-manage-subject-"));
		execFileSync("git", ["-C", subjectDir, "init", "-q"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "config", "user.email", "test@example.com"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "config", "user.name", "Test"], { stdio: "pipe" });
		await writeFile(join(subjectDir, "artifact.txt"), "before\n");
		execFileSync("git", ["-C", subjectDir, "add", "artifact.txt"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "commit", "-q", "-m", "init"], { stdio: "pipe" });

		await createOneShot("subject-drift", { verificationRequired: true });
		const withVerifier = {
			...options,
			workingDirectory: subjectDir,
			dispatchVerification: async () => true,
		};
		await manageTask(withVerifier, {
			action: "request-verification",
			id: "subject-drift",
			note: "Ready for independent verification.",
		});
		const subjectHash = await workspaceSubjectHash(subjectDir);
		expect(subjectHash).toBeDefined();
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "subject-run",
			taskId: "subject-drift",
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists.",
			workspaceChanged: false,
			subjectHash,
			subjectDir,
		});
		await manageTask(withVerifier, {
			action: "verify",
			id: "subject-drift",
			verifierRunId: attestation.runId,
		});

		await writeFile(join(subjectDir, "artifact.txt"), "after\n");
		const taskPath = join(tasksDir, "subject-drift.md");
		const stored = await readFile(taskPath, "utf-8");
		const controlLine = stored.match(/^control: (.+)$/m);
		expect(controlLine?.[1]).toBeDefined();
		const control = JSON.parse(controlLine?.[1] ?? "{}") as {
			verification?: { subjectHash?: string };
		};
		delete control.verification?.subjectHash;
		await writeFile(taskPath, stored.replace(/^control: .+$/m, `control: ${JSON.stringify(control)}`));

		await expect(
			manageTask(withVerifier, {
				action: "complete",
				id: "subject-drift",
				summary: "Result is complete.",
				evidence: "Independent verifier passed before the subject drifted.",
			}),
		).rejects.toThrow(/artifacts changed/);
		expect(existsSync(taskPath)).toBe(true);
	});

	it("completes one-shot work directly into the archive", async () => {
		await createOneShot("done");
		const result = await manageTask(options, {
			action: "complete",
			id: "done",
			summary: "Finished.",
			evidence: "The checked DoD item is present.",
		});
		expect(result).toMatchObject({ archived: true, status: undefined });
		expect(existsSync(join(tasksDir, "done.md"))).toBe(false);
		expect(await readFile(join(tasksDir, "archive", "done.md"), "utf-8")).toContain("outcome: completed");
	});

	it("closes recurring complete and skip as sleeping, not as live terminal states", async () => {
		await writeTask("complete-cycle", "status: active\nschedule: 0 9 * * 1");
		const completed = await manageTask(options, {
			action: "complete",
			id: "complete-cycle",
			summary: "Cycle complete.",
			evidence: "All checks passed.",
		});
		expect(completed).toMatchObject({ status: "sleeping", archived: false });
		const completedStored = await readStoredTask(channelDir, "complete-cycle");
		expect(completedStored?.fields.status).toBe("sleeping");
		expect(completedStored?.fields.wake).toBeDefined();

		await writeTask(
			"skip-cycle",
			`status: active\nschedule: 0 9 * * 1\ncontrol: ${JSON.stringify(createDefaultTaskControl())}`,
		);
		const skipped = await manageTask(options, {
			action: "skip",
			id: "skip-cycle",
			reason: "The source report was not produced.",
		});
		expect(skipped).toMatchObject({ status: "sleeping", archived: false });
		const skippedStored = await readStoredTask(channelDir, "skip-cycle");
		expect(skippedStored?.fields.status).toBe("sleeping");
		expect(skippedStored?.fields.control?.verification.status).toBe("pending");
	});

	it("cancels a sleeping recurring task into a cancelled archive", async () => {
		await writeTask("cancel-cycle", "status: sleeping\nschedule: 0 9 * * 1\nwake: 2026-08-10T09:00:00+08:00");
		const result = await manageTask(options, { action: "cancel", id: "cancel-cycle", reason: "No longer needed." });
		expect(result).toMatchObject({ archived: true });
		expect(await readFile(join(tasksDir, "archive", "cancel-cycle.md"), "utf-8")).toContain("outcome: cancelled");
	});

	it("keeps task ids and document sections strict", async () => {
		await expect(
			manageTask(options, { action: "create", id: "bad/id", title: "Bad", goal: "G", dod: "- [ ] D" }),
		).rejects.toThrow(/Invalid task id/);
		await expect(
			manageTask(options, { action: "create", id: "no-dod", title: "No DoD", goal: "G", dod: "prose" }),
		).rejects.toThrow(/no checklist items/);
	});
});
