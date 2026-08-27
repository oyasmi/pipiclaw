import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLocalTime } from "../src/shared/local-time.js";
import { getSubAgentRunManager } from "../src/subagents/runs.js";
import { workspaceSubjectHash, workspaceSubjectSnapshot } from "../src/tasks/artifact-subject.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import { renderStandardTaskBody } from "../src/tasks/ledger.js";
import { readStoredTask, taskBodyHash } from "../src/tasks/store.js";
import { nextTaskWake } from "../src/tasks/task-schedule.js";
import {
	readVerificationAttestation,
	verificationAttestationPath,
	writeVerificationAttestation,
} from "../src/tasks/verification.js";
import { createTask } from "../src/tools/task-manage/create.js";
import { closeTask, updateTask } from "../src/tools/task-manage/lifecycle.js";
import type { TaskManageToolOptions } from "../src/tools/task-manage/types.js";
import { verifyTask } from "../src/tools/task-manage/verification.js";

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

describe("task_create/task_update/task_close/task_verify (spec 046, D3)", () => {
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

	async function createOneShot(id = "work", verificationRequired?: boolean): Promise<void> {
		await createTask(options, {
			id,
			title: "Work",
			goal: "Do the work.",
			dod: "- [x] Result is ready",
			verificationRequired,
		});
	}

	async function registerSettledVerificationRun(
		runId: string,
		taskId: string,
		workingDirectory: string,
	): Promise<void> {
		const artifactDir = join(channelDir, "subagent-artifacts", runId);
		await mkdir(artifactDir, { recursive: true });
		const manager = getSubAgentRunManager(CHANNEL_ID);
		await manager.register({
			runId,
			channelId: CHANNEL_ID,
			runtime: "internal",
			agent: "verifier",
			label: "verify",
			source: "inline",
			tools: ["bash"],
			purpose: "verify",
			taskId,
			workingDirectory,
			artifactDir,
			mutates: "write",
		});
		await manager.settle(
			runId,
			{
				status: "completed",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				usageKnown: true,
				costKnown: true,
				turns: 0,
				toolCalls: 0,
				durationMs: 1,
				outputText: "VERDICT: PASS",
			},
			{ announce: false },
		);
	}

	it("creates recurring work sleeping with its first occurrence and no dispatch", async () => {
		const result = await createTask(options, {
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

	it("rejects sleeping for a one-shot task", async () => {
		await expect(
			createTask(options, { id: "bad", title: "Bad", goal: "G", dod: "- [ ] D", status: "sleeping" }),
		).rejects.toThrow(/one-shot/);
	});

	it("checkpoints active work (task_update with note) and normalizes a future wake to waiting", async () => {
		await createOneShot("progress");
		const futureWake = formatLocalTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
		const result = await updateTask(options, {
			id: "progress",
			note: "Build complete; wait for the scheduled check.",
			wake: futureWake,
		});
		expect(result.status).toBe("waiting");
		const stored = await readStoredTask(channelDir, "progress");
		expect(stored?.fields).toMatchObject({ status: "waiting", wake: futureWake });
		expect(stored?.fields.control?.waitingFor).toBe("time");
	});

	it("imports a real verifier attestation and then completes without approval", async () => {
		await createOneShot("verified", true);
		// Parked the same way any other delegation parks — no special "verification" status.
		await updateTask(options, {
			id: "verified",
			note: "Dispatched an independent purpose=verify sub-agent.",
			status: "waiting",
		});
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "run-1",
			taskId: "verified",
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists and the test command passed.",
			workspaceChanged: false,
			verificationStrength: "enforced",
		});
		const verified = await verifyTask(options, { id: "verified", verifierRunId: attestation.runId });
		expect(verified.status).toBe("active");
		const completed = await closeTask(options, {
			id: "verified",
			outcome: "complete",
			summary: "Result is complete.",
			evidence: "Independent verifier run-1 passed.",
		});
		expect(completed).toMatchObject({ action: "close", archived: true });
		const archive = join(tasksDir, "archive", "verified.md");
		expect(existsSync(archive)).toBe(true);
		const archived = await readFile(archive, "utf-8");
		expect(archived).toContain("outcome: completed");
		expect(archived).not.toContain("status:");
	});

	it("reads a legacy fieldless subject attestation with explicit HEAD-sensitive compatibility", async () => {
		const taskId = "legacy-attestation";
		await createOneShot(taskId, true);
		const task = await readStoredTask(channelDir, taskId);
		expect(task).toBeDefined();
		if (!task) return;
		const runId = "legacy-run";
		await mkdir(join(channelDir, "tasks", ".verifications"), { recursive: true });
		await writeFile(
			verificationAttestationPath(channelDir, runId),
			`${JSON.stringify({
				version: 1,
				runId,
				taskId,
				verdict: "pass",
				checkedAt: "2026-08-04T12:00:00+08:00",
				bodyHash: taskBodyHash(task.body),
				evidence: "Legacy verifier evidence.",
				workspaceChanged: false,
				subjectHash: "a".repeat(64),
			})}\n`,
			"utf-8",
		);

		const attestation = await readVerificationAttestation(channelDir, runId);
		expect(attestation.subjectMode).toBe("legacy-head");
		expect(attestation.subjectBaseCommit).toBeUndefined();
		expect(attestation.verificationStrength).toBe("enforced");
	});

	it("rejects an attestation subjectDir that does not match the persisted run checkout", async () => {
		const trustedDir = join(workspaceDir, "trusted-checkout");
		const otherDir = join(workspaceDir, "other-checkout");
		await mkdir(trustedDir, { recursive: true });
		await mkdir(otherDir, { recursive: true });
		const taskId = "subject-binding";
		await createOneShot(taskId, true);
		await updateTask(
			{ ...options, workingDirectory: trustedDir },
			{ id: taskId, note: "Dispatched an independent purpose=verify sub-agent.", status: "waiting" },
		);
		await registerSettledVerificationRun("subject-binding-run", taskId, trustedDir);
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "subject-binding-run",
			taskId,
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists.",
			workspaceChanged: false,
			subjectHash: "a".repeat(64),
			subjectDir: otherDir,
			verificationStrength: "advisory",
		});

		await expect(
			verifyTask({ ...options, workingDirectory: trustedDir }, { id: taskId, verifierRunId: attestation.runId }),
		).rejects.toThrow(/subjectDir does not match its persisted workingDirectory/);
	});

	it("fails closed for a subject-bearing attestation whose run record is unavailable", async () => {
		const taskId = "subject-missing-run";
		const checkout = join(workspaceDir, "checkout");
		await mkdir(checkout, { recursive: true });
		await createOneShot(taskId, true);
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "subject-missing-run-record",
			taskId,
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists.",
			workspaceChanged: false,
			subjectHash: "b".repeat(64),
			subjectDir: checkout,
			verificationStrength: "advisory",
		});

		await expect(
			readVerificationAttestation(channelDir, attestation.runId, { trustedWorkingDirectory: undefined }),
		).rejects.toThrow(/no persisted workingDirectory is available/);
	});

	it("canonicalizes a valid subject alias against a settled run record", async () => {
		const checkout = join(workspaceDir, "settled-checkout");
		const alias = join(workspaceDir, "settled-alias");
		await mkdir(checkout, { recursive: true });
		symlinkSync(checkout, alias, "dir");
		const taskId = "subject-alias";
		await createOneShot(taskId, true);
		await registerSettledVerificationRun("subject-alias-run", taskId, checkout);
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "subject-alias-run",
			taskId,
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists.",
			workspaceChanged: false,
			subjectHash: "c".repeat(64),
			subjectDir: alias,
			verificationStrength: "advisory",
		});
		const run = getSubAgentRunManager(CHANNEL_ID).get(attestation.runId);
		const bound = await readVerificationAttestation(channelDir, attestation.runId, {
			trustedWorkingDirectory: run?.workingDirectory,
		});

		expect(bound.subjectDir).toBe(realpathSync(checkout));
	});

	it("rechecks the attestation subject binding during task_close", async () => {
		const trustedDir = join(workspaceDir, "close-trusted-checkout");
		const otherDir = join(workspaceDir, "close-other-checkout");
		await mkdir(trustedDir, { recursive: true });
		await mkdir(otherDir, { recursive: true });
		const taskId = "close-subject-binding";
		await createOneShot(taskId, true);
		const withSubject = { ...options, workingDirectory: trustedDir };
		await updateTask(withSubject, {
			id: taskId,
			note: "Dispatched an independent purpose=verify sub-agent.",
			status: "waiting",
		});
		await registerSettledVerificationRun("close-subject-binding-run", taskId, trustedDir);
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "close-subject-binding-run",
			taskId,
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists.",
			workspaceChanged: false,
			verificationStrength: "advisory",
		});
		await verifyTask(withSubject, { id: taskId, verifierRunId: attestation.runId });

		const attestationPath = verificationAttestationPath(channelDir, attestation.runId);
		const tampered = JSON.parse(await readFile(attestationPath, "utf-8")) as Record<string, unknown>;
		tampered.subjectHash = "d".repeat(64);
		tampered.subjectDir = otherDir;
		await writeFile(attestationPath, `${JSON.stringify(tampered)}\n`, "utf-8");

		await expect(
			closeTask(withSubject, {
				id: taskId,
				outcome: "complete",
				summary: "Result is complete.",
				evidence: "Independent verifier passed.",
			}),
		).rejects.toThrow(/subjectDir does not match its persisted workingDirectory/);
	});

	it("anchors completion subject freshness to the attestation, with no mirrored field to drift", async () => {
		subjectDir = await mkdtemp(join(tmpdir(), "task-manage-subject-"));
		execFileSync("git", ["-C", subjectDir, "init", "-q"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "config", "user.email", "test@example.com"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "config", "user.name", "Test"], { stdio: "pipe" });
		await writeFile(join(subjectDir, "artifact.txt"), "before\n");
		execFileSync("git", ["-C", subjectDir, "add", "artifact.txt"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "commit", "-q", "-m", "init"], { stdio: "pipe" });
		const subjectAlias = join(workspaceDir, "subject-alias");
		symlinkSync(subjectDir, subjectAlias, "dir");

		await createOneShot("subject-drift", true);
		const withSubject = { ...options, workingDirectory: subjectDir };
		await updateTask(withSubject, {
			id: "subject-drift",
			note: "Dispatched an independent purpose=verify sub-agent.",
			status: "waiting",
		});
		await registerSettledVerificationRun("subject-run", "subject-drift", subjectDir);
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
			subjectDir: subjectAlias,
			verificationStrength: "enforced",
		});
		await verifyTask(withSubject, { id: "subject-drift", verifierRunId: attestation.runId });

		// The artifact drifts after verify. There is no mirrored subjectHash left in control to
		// tamper with — freshness is checked straight off the attestation file every time.
		await writeFile(join(subjectDir, "artifact.txt"), "after\n");
		const taskPath = join(tasksDir, "subject-drift.md");

		await expect(
			closeTask(withSubject, {
				id: "subject-drift",
				outcome: "complete",
				summary: "Result is complete.",
				evidence: "Independent verifier passed before the subject drifted.",
			}),
		).rejects.toThrow(/artifacts changed/);
		expect(existsSync(taskPath)).toBe(true);
	});

	it("lets task_close accept a normal commit of content already checked by a base-relative attestation", async () => {
		subjectDir = await mkdtemp(join(tmpdir(), "task-manage-base-subject-"));
		execFileSync("git", ["-C", subjectDir, "init", "-q"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "config", "user.email", "test@example.com"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "config", "user.name", "Test"], { stdio: "pipe" });
		await writeFile(join(subjectDir, "artifact.txt"), "before\n");
		execFileSync("git", ["-C", subjectDir, "add", "artifact.txt"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "commit", "-q", "-m", "init"], { stdio: "pipe" });

		await writeFile(join(subjectDir, "artifact.txt"), "verified\n");
		const snapshot = await workspaceSubjectSnapshot(subjectDir);
		expect(snapshot).toBeDefined();
		if (!snapshot) return;

		await createOneShot("subject-commit", true);
		const withSubject = { ...options, workingDirectory: subjectDir };
		await updateTask(withSubject, { id: "subject-commit", note: "Dispatched verifier.", status: "waiting" });
		await registerSettledVerificationRun("subject-base-run", "subject-commit", subjectDir);
		const attestation = await writeVerificationAttestation(channelDir, {
			runId: "subject-base-run",
			taskId: "subject-commit",
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The implementation and checks passed.",
			workspaceChanged: false,
			subjectHash: snapshot.hash,
			subjectDir,
			subjectMode: "base-relative",
			subjectBaseCommit: snapshot.baseCommit,
			subjectBaselineUntrackedPaths: snapshot.baselineUntrackedPaths,
			verificationStrength: "advisory",
		});
		await verifyTask(withSubject, { id: "subject-commit", verifierRunId: attestation.runId });

		execFileSync("git", ["-C", subjectDir, "add", "artifact.txt"], { stdio: "pipe" });
		execFileSync("git", ["-C", subjectDir, "commit", "-q", "-m", "ship verified content"], { stdio: "pipe" });
		await expect(
			closeTask(withSubject, {
				id: "subject-commit",
				outcome: "complete",
				summary: "Result is complete.",
				evidence: "Independent verifier passed before the normal commit.",
			}),
		).resolves.toMatchObject({ action: "close", archived: true });
	});

	it("completes one-shot work directly into the archive", async () => {
		await createOneShot("done");
		const result = await closeTask(options, {
			id: "done",
			outcome: "complete",
			summary: "Finished.",
			evidence: "The checked DoD item is present.",
		});
		expect(result).toMatchObject({ archived: true, status: undefined });
		expect(existsSync(join(tasksDir, "done.md"))).toBe(false);
		expect(await readFile(join(tasksDir, "archive", "done.md"), "utf-8")).toContain("outcome: completed");
	});

	it("deletes only the closed task's own events, not a sibling task whose id is a dotted extension of it", async () => {
		// "v1" is a string-prefix of "v1.2-release"; task ids may contain dots (TASK_ID_PATTERN),
		// so cleanup must match the parsed id exactly, not `startsWith("task.<channel>.v1.")`.
		await createOneShot("v1");
		await writeTask("v1.2-release", "status: active");
		const eventsDir = join(workspaceDir, "events");
		await mkdir(eventsDir, { recursive: true });
		const ownEvent = join(eventsDir, "task.dm_1.v1.checkin.json");
		const siblingEvent = join(eventsDir, "task.dm_1.v1.2-release.checkin.json");
		const eventBody = JSON.stringify({
			type: "periodic",
			channelId: CHANNEL_ID,
			text: "check",
			schedule: "0 * * * *",
		});
		await writeFile(ownEvent, eventBody);
		await writeFile(siblingEvent, eventBody);

		await closeTask(options, {
			id: "v1",
			outcome: "complete",
			summary: "Finished.",
			evidence: "The checked DoD item is present.",
		});

		expect(existsSync(ownEvent)).toBe(false);
		expect(existsSync(siblingEvent)).toBe(true);
	});

	it("closes recurring complete and skip as sleeping, not as live terminal states", async () => {
		await writeTask("complete-cycle", "status: active\nschedule: 0 9 * * 1");
		const completed = await closeTask(options, {
			id: "complete-cycle",
			outcome: "complete",
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
		const skipped = await closeTask(options, {
			id: "skip-cycle",
			outcome: "skip",
			reason: "The source report was not produced.",
		});
		expect(skipped).toMatchObject({ status: "sleeping", archived: false });
		const skippedStored = await readStoredTask(channelDir, "skip-cycle");
		expect(skippedStored?.fields.status).toBe("sleeping");
		expect(skippedStored?.fields.control?.verification.status).toBe("pending");
	});

	it("cancels a sleeping recurring task into a cancelled archive", async () => {
		await writeTask("cancel-cycle", "status: sleeping\nschedule: 0 9 * * 1\nwake: 2026-08-10T09:00:00+08:00");
		const result = await closeTask(options, { id: "cancel-cycle", outcome: "cancel", reason: "No longer needed." });
		expect(result).toMatchObject({ archived: true });
		expect(await readFile(join(tasksDir, "archive", "cancel-cycle.md"), "utf-8")).toContain("outcome: cancelled");
	});

	it("keeps task ids and document sections strict", async () => {
		await expect(createTask(options, { id: "bad/id", title: "Bad", goal: "G", dod: "- [ ] D" })).rejects.toThrow(
			/Invalid task id/,
		);
		await expect(createTask(options, { id: "no-dod", title: "No DoD", goal: "G", dod: "prose" })).rejects.toThrow(
			/no checklist items/,
		);
	});
});
