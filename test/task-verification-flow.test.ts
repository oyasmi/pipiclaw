import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimVerifiedDelegationWake } from "../src/runtime/task-wake.js";
import { configureSubAgentRuntime, getSubAgentRunManager } from "../src/subagents/runs.js";
import { readStoredTask } from "../src/tasks/store.js";
import { writeVerificationAttestation } from "../src/tasks/verification.js";
import { createTask } from "../src/tools/task-manage/create.js";
import { closeTask, updateTask } from "../src/tools/task-manage/lifecycle.js";
import type { TaskManageToolOptions } from "../src/tools/task-manage/types.js";
import { verifyTask } from "../src/tools/task-manage/verification.js";
import { createFakeEvent } from "./helpers/fixtures.js";

/**
 * Full independent-verification lifecycle through the real delegation-wake path, replacing the
 * now-deleted request-verification flow (spec: docs/reviews/2026-08-23-task-mechanism-subtraction.md
 * §3.3). Before this change, a task parked with `waitingFor: "verification"` could never be
 * reactivated by a completion wake — `claimVerifiedDelegationWake` only ever matched
 * `waitingFor: "external-signal"` — which is the P0 deadlock the subtraction fixes by deleting the
 * competing stopping semantic outright. This test proves the replacement flow (park exactly like
 * any other delegation, then verify) survives the real wake path end to end.
 */
describe("independent verification via a normal delegation wake", () => {
	const channelId = "dm_verify_flow";
	let workspaceDir: string;
	let channelDir: string;
	let options: TaskManageToolOptions;

	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-verify-flow-"));
		channelDir = join(workspaceDir, channelId);
		await mkdir(join(channelDir, "tasks", "archive"), { recursive: true });
		options = { workspaceDir, channelDir, channelId };
		configureSubAgentRuntime({});
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	it("dispatches a verify sub-agent, parks, wakes, verifies, and completes", async () => {
		const taskId = "verify-flow";
		await createTask(options, {
			id: taskId,
			title: "Work",
			goal: "Do the work.",
			dod: "- [x] Result is ready",
			verificationRequired: true,
		});

		// Step 1: the model dispatched a purpose=verify sub-agent and parked exactly like any
		// other delegation — no special "verification" lifecycle status.
		const parked = await updateTask(options, {
			id: taskId,
			note: "Dispatched an independent purpose=verify sub-agent; waiting for its completion wake.",
			status: "waiting",
		});
		expect(parked.status).toBe("waiting");
		const parkedStored = await readStoredTask(channelDir, taskId);
		expect(parkedStored?.fields.control?.waitingFor).toBe("external-signal");

		// Step 2: the verify sub-agent run settles and produces a real completion wake — the same
		// mechanism every delegation wake goes through (spec 040, T9's verified-wake path).
		const runManager = getSubAgentRunManager(channelId);
		const runId = "run-verify-flow";
		await runManager.register({
			runId,
			channelId,
			runtime: "internal",
			agent: "verifier",
			label: "verify",
			source: "inline",
			tools: [],
			purpose: "verify",
			taskId,
			workingDirectory: workspaceDir,
			artifactDir: join(workspaceDir, "artifacts", runId),
		});
		await runManager.settle(
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
			{ announce: true },
		);
		const dispatchId = `subagent:${channelId}:${runId}:done`;
		const wake = createFakeEvent({
			channelId,
			text: `[SUBAGENT:${runId}] done. It belongs to task ${taskId}.`,
			dispatchId,
			internalWake: { kind: "subagent", resourceId: runId, taskId, dispatchId },
		});
		const claimed = await claimVerifiedDelegationWake(wake, workspaceDir);
		expect(claimed?.activated).toBe(true);
		await claimed?.finish();

		// The wake already reactivated the task before the model's next turn — this is exactly
		// where the old flow deadlocked (activateWaitingTaskAndClaimAttempt only ever matched
		// waitingFor: "external-signal", never the retired "verification" value).
		const reactivated = await readStoredTask(channelDir, taskId);
		expect(reactivated?.fields.status).toBe("active");

		// Step 3: import the attestation. verify's only gate is that the attestation belongs to
		// this task — no waitingFor check at all.
		const attestation = await writeVerificationAttestation(channelDir, {
			runId,
			taskId,
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "The checked result exists and the test command passed.",
			workspaceChanged: false,
			verificationStrength: "enforced",
		});
		const verified = await verifyTask(options, { id: taskId, verifierRunId: attestation.runId });
		expect(verified.status).toBe("active");
		const verifiedStored = await readStoredTask(channelDir, taskId);
		expect(verifiedStored?.fields.control?.verification).toMatchObject({ required: true, status: "passed", runId });

		// Step 4: complete re-checks the attestation directly against the current body hash.
		const completed = await closeTask(options, {
			id: taskId,
			outcome: "complete",
			summary: "Result is complete.",
			evidence: `Independent verifier ${runId} passed.`,
		});
		expect(completed).toMatchObject({ action: "close", archived: true });
	});

	// Review 2026-08-23 §2.1: `verificationStrength` was computed and attested but never reached
	// anything a human/model actually reads — surface it at verify and complete time instead.
	it("surfaces an advisory verification strength at verify and complete time", async () => {
		const taskId = "verify-flow-advisory";
		await createTask(options, {
			id: taskId,
			title: "Work",
			goal: "Do the work.",
			dod: "- [x] Result is ready",
			verificationRequired: true,
		});
		await updateTask(options, { id: taskId, note: "Dispatched.", status: "waiting" });

		const runId = "run-verify-advisory";
		const attestation = await writeVerificationAttestation(channelDir, {
			runId,
			taskId,
			verdict: "pass",
			checkedAt: "2026-08-04T12:00:00+08:00",
			evidence: "External verifier reported PASS.",
			workspaceChanged: false,
			verificationStrength: "advisory",
		});
		expect(attestation.verificationStrength).toBe("advisory");

		const verified = await verifyTask(options, { id: taskId, verifierRunId: runId });
		expect(verified.notice).toMatch(/advisory/i);

		const completed = await closeTask(options, {
			id: taskId,
			outcome: "complete",
			summary: "Result is complete.",
			evidence: `Independent verifier ${runId} passed.`,
		});
		expect(completed.notice).toMatch(/advisory/i);
	});
});
