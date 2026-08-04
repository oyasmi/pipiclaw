import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyTaskControlPatch,
	createDefaultTaskControl,
	parseTaskControl,
	resetTaskControlForCycle,
	retiredTaskControlKeys,
	taskBudgetViolation,
} from "../src/tasks/control.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { activateWaitingTask, claimTaskAttempt, finishTaskAttempt, readStoredTask } from "../src/tasks/store.js";
import { parseVerificationVerdict } from "../src/tasks/verification.js";

describe("TaskControl v2", () => {
	it("creates only the v2 control contract", () => {
		const control = createDefaultTaskControl(true, {
			createdBy: "alice",
			createdAt: "2026-08-04T09:00:00+08:00",
			sourceMessageId: "msg-1",
		});
		expect(control).toMatchObject({
			version: 2,
			priority: "normal",
			budget: { maxAttempts: 12 },
			verification: { required: true, status: "pending" },
			provenance: { createdBy: "alice", sourceMessageId: "msg-1" },
		});
		for (const key of ["sideEffects", "externalApproval", "approvalBy", "approvedAt", "approvalBodyHash"]) {
			expect(control).not.toHaveProperty(key);
		}
	});

	it("reads v1 fields conservatively and writes a clean v2 object", () => {
		const raw = {
			version: 1,
			priority: "high",
			pausedBy: "governor",
			blockedReason: "attempt budget exhausted",
			sideEffects: "external",
			externalApproval: "granted",
			approvalBy: "Alice",
			approvedAt: "2026-08-03T09:00:00+08:00",
			approvalBodyHash: "a".repeat(64),
			budget: { maxAttempts: 4, maxTokens: 9999 },
			usage: { attempts: 2, tokens: 10, costUsd: 0, wallTimeMinutes: 1 },
			verification: { mode: "independent", status: "pending" },
		};
		const parsed = parseTaskControl(JSON.stringify(raw));
		expect(parsed).toMatchObject({
			version: 2,
			priority: "high",
			budget: { maxAttempts: 4 },
			verification: { required: true, status: "pending" },
			stop: { by: "governor", reason: "attempt budget exhausted" },
		});
		expect(parsed).not.toHaveProperty("sideEffects");
		expect(parsed).not.toHaveProperty("externalApproval");
		expect(retiredTaskControlKeys(raw)).toEqual(
			expect.arrayContaining([
				"sideEffects",
				"externalApproval",
				"approvalBy",
				"approvedAt",
				"approvalBodyHash",
				"pausedBy",
			]),
		);
	});

	it("patches waiting and verification facts without deriving approval", () => {
		const control = applyTaskControlPatch(createDefaultTaskControl(), {
			priority: "critical",
			deadline: "2026-08-05T18:00:00+08:00",
			nextAction: "Wait for the build job",
			waitingFor: "job",
			verificationRequired: true,
			maxAttempts: 20,
		});
		expect(control).toMatchObject({
			priority: "critical",
			waitingFor: "job",
			budget: { maxAttempts: 20 },
			verification: { required: true, status: "pending" },
		});
		expect(control).not.toHaveProperty("externalApproval");
	});

	it("resets only per-cycle facts and preserves provenance", () => {
		const control = createDefaultTaskControl(true, { createdBy: "alice" });
		control.usage = { attempts: 3, tokens: 100, costUsd: 1, costKnown: true, wallTimeMinutes: 4 };
		control.waitingFor = "verification";
		control.stop = { by: "governor", reason: "old cycle", at: "2026-08-03T09:00:00+08:00" };
		control.verification = { required: true, status: "passed", runId: "old" };
		const reset = resetTaskControlForCycle(control, "cycle-2026-08-04");
		expect(reset).toMatchObject({
			cycleId: "cycle-2026-08-04",
			lastOutcome: "pending",
			usage: { attempts: 0, tokens: 0, costUsd: 0, wallTimeMinutes: 0 },
			verification: { required: true, status: "pending" },
			provenance: { createdBy: "alice" },
		});
		expect(reset.stop).toBeUndefined();
		expect(reset.waitingFor).toBeUndefined();
	});

	it("governs active work but not parked or sleeping work", () => {
		const control = createDefaultTaskControl();
		control.usage.attempts = control.budget.maxAttempts;
		expect(taskBudgetViolation(control, 0, "active")).toContain("attempt budget exhausted");
		expect(taskBudgetViolation(control, 0, "waiting")).toBeUndefined();
		expect(taskBudgetViolation(control, 0, "sleeping")).toBeUndefined();
		control.deadline = "2026-08-03T00:00:00+08:00";
		expect(taskBudgetViolation(control, Date.parse("2026-08-04T00:00:00+08:00"), "waiting")).toContain(
			"deadline exceeded",
		);
	});

	it("rejects invalid v2 values with a repair-oriented error", () => {
		const control = createDefaultTaskControl();
		expect(() => parseTaskControl(JSON.stringify({ ...control, deadline: "someday" }))).toThrow(/deadline/);
		expect(() => parseTaskControl(JSON.stringify({ ...control, waitingFor: "approval" }))).toThrow(/one of/);
		expect(() => parseTaskControl(JSON.stringify({ ...control, version: 3 }))).toThrow(/version 1 or version 2/);
	});
});

describe("task attempt accounting", () => {
	let root: string;
	let channelDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "task-control-v2-"));
		channelDir = join(root, "dm_1");
		await mkdir(join(channelDir, "tasks", "archive"), { recursive: true });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("claims an active attempt and records runtime telemetry", async () => {
		const path = join(channelDir, "tasks", "work.md");
		await writeFile(
			path,
			renderTaskDocument(
				{ status: "active", control: createDefaultTaskControl() },
				"# Work\n\n## Current Cycle\n- start\n",
			),
		);
		const claim = await claimTaskAttempt(channelDir, "work", new Date("2026-08-04T09:00:00+08:00"));
		expect(claim?.generation).toBe(1);
		await finishTaskAttempt(channelDir, "work", {
			tokens: 123.9,
			costUsd: 0.45,
			costKnown: true,
			wallTimeMinutes: 2.5,
			failed: false,
			finishedAt: new Date("2026-08-04T09:03:00+08:00"),
			generation: claim?.generation,
		});
		const stored = await readStoredTask(channelDir, "work");
		expect(stored?.fields.control).toMatchObject({
			attemptGeneration: 1,
			lastOutcome: "progress",
			usage: { attempts: 1, tokens: 123, costUsd: 0.45, wallTimeMinutes: 2.5 },
		});
	});

	it("does not charge a silent turn while retaining its spend audit", async () => {
		const path = join(channelDir, "tasks", "quiet.md");
		await writeFile(path, renderTaskDocument({ status: "active", control: createDefaultTaskControl() }, "# Quiet\n"));
		const claim = await claimTaskAttempt(channelDir, "quiet", new Date("2026-08-04T09:00:00+08:00"));
		await finishTaskAttempt(channelDir, "quiet", {
			tokens: 42,
			costUsd: 0.01,
			costKnown: true,
			wallTimeMinutes: 0.5,
			failed: false,
			silent: true,
			finishedAt: new Date("2026-08-04T09:01:00+08:00"),
			generation: claim?.generation,
		});
		const stored = await readStoredTask(channelDir, "quiet");
		expect(stored?.fields.control?.usage).toMatchObject({ attempts: 0, tokens: 42 });
		expect(stored?.fields.control?.lastOutcome).toBe("pending");
	});

	it("does not let a job completion wake a task waiting for another source", async () => {
		const path = join(channelDir, "tasks", "source.md");
		await writeFile(
			path,
			renderTaskDocument(
				{ status: "waiting", control: { ...createDefaultTaskControl(), waitingFor: "user" } },
				"# Source\n",
			),
		);
		expect(await activateWaitingTask(channelDir, "source", "job")).toBeUndefined();
		expect((await readStoredTask(channelDir, "source"))?.fields.status).toBe("waiting");
		expect(await activateWaitingTask(channelDir, "source", "user")).toBeDefined();
		expect((await readStoredTask(channelDir, "source"))?.fields.status).toBe("active");
	});

	it("creates a v2 control block when a legacy active task is first claimed", async () => {
		const path = join(channelDir, "tasks", "legacy.md");
		await writeFile(path, renderTaskDocument({ status: "active" }, "# Legacy\n"));
		const claim = await claimTaskAttempt(channelDir, "legacy", new Date("2026-08-04T09:00:00+08:00"));
		expect(claim?.control.version).toBe(2);
		expect((await readStoredTask(channelDir, "legacy"))?.fields.control?.usage.attempts).toBe(1);
	});
});

describe("verification parser", () => {
	it("uses the final explicit verdict only", () => {
		expect(parseVerificationVerdict("VERDICT: FAIL\nnotes\nVERDICT: PASS")).toBe("pass");
		expect(parseVerificationVerdict("looks good")).toBeUndefined();
	});
});
