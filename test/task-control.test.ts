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
import { activateWaitingTask, readStoredTask } from "../src/tasks/store.js";
import { parseVerificationVerdict } from "../src/tasks/verification.js";

describe("TaskControl v2", () => {
	it("creates only the v2 control contract", () => {
		const control = createDefaultTaskControl(true);
		expect(control).toMatchObject({
			version: 2,
			priority: "normal",
			verification: { required: true, status: "pending" },
		});
		for (const key of [
			"sideEffects",
			"externalApproval",
			"approvalBy",
			"approvedAt",
			"approvalBodyHash",
			"provenance",
			"budget",
			"usage",
			"attemptGeneration",
			"lastOutcome",
			"wakeHandoff",
		]) {
			expect(control).not.toHaveProperty(key);
		}
	});

	it("reads v1 fields conservatively and writes a clean v2 object", () => {
		const raw = {
			version: 1,
			priority: "high",
			pausedBy: "governor",
			blockedReason: "legacy stop reason",
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
			verification: { required: true, status: "pending" },
			stop: { by: "governor", reason: "legacy stop reason" },
		});
		expect(parsed).not.toHaveProperty("sideEffects");
		expect(parsed).not.toHaveProperty("externalApproval");
		expect(parsed).not.toHaveProperty("budget");
		expect(parsed).not.toHaveProperty("usage");
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
		});
		expect(control).toMatchObject({
			priority: "critical",
			waitingFor: "job",
			verification: { required: true, status: "pending" },
		});
		expect(control).not.toHaveProperty("externalApproval");
	});

	it("resets only per-cycle facts", () => {
		const control = createDefaultTaskControl(true);
		control.waitingFor = "external-signal";
		control.stop = { by: "governor", reason: "old cycle", at: "2026-08-03T09:00:00+08:00" };
		control.verification = { required: true, status: "passed", runId: "old" };
		const reset = resetTaskControlForCycle(control, "cycle-2026-08-04");
		expect(reset).toMatchObject({
			cycleId: "cycle-2026-08-04",
			verification: { required: true, status: "pending" },
		});
		expect(reset.stop).toBeUndefined();
		expect(reset.waitingFor).toBeUndefined();
	});

	it("governs work by deadline only, and not while sleeping", () => {
		const control = createDefaultTaskControl();
		control.deadline = "2026-08-03T00:00:00+08:00";
		expect(taskBudgetViolation(control, Date.parse("2026-08-04T00:00:00+08:00"), "active")).toContain(
			"deadline exceeded",
		);
		expect(taskBudgetViolation(control, Date.parse("2026-08-04T00:00:00+08:00"), "waiting")).toContain(
			"deadline exceeded",
		);
		expect(taskBudgetViolation(control, Date.parse("2026-08-04T00:00:00+08:00"), "sleeping")).toBeUndefined();
		expect(taskBudgetViolation(control, Date.parse("2026-08-02T00:00:00+08:00"), "active")).toBeUndefined();
	});

	it("rejects invalid v2 values with a repair-oriented error", () => {
		const control = createDefaultTaskControl();
		expect(() => parseTaskControl(JSON.stringify({ ...control, deadline: "someday" }))).toThrow(/deadline/);
		expect(() => parseTaskControl(JSON.stringify({ ...control, waitingFor: "approval" }))).toThrow(/one of/);
		expect(() => parseTaskControl(JSON.stringify({ ...control, version: 3 }))).toThrow(/version 1 or version 2/);
	});
});

describe("waiting task activation", () => {
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

	it("activates a waiting task regardless of its waitingFor value (display-only, not a gate)", async () => {
		const path = join(channelDir, "tasks", "source.md");
		await writeFile(
			path,
			renderTaskDocument(
				{ status: "waiting", control: { ...createDefaultTaskControl(), waitingFor: "user" } },
				"# Source\n",
			),
		);
		expect(await activateWaitingTask(channelDir, "source")).toBeDefined();
		expect((await readStoredTask(channelDir, "source"))?.fields.status).toBe("active");
	});

	it("gives a hand-written v2 control block to a legacy task on first activation", async () => {
		const path = join(channelDir, "tasks", "legacy.md");
		await writeFile(path, renderTaskDocument({ status: "waiting" }, "# Legacy\n"));
		const activated = await activateWaitingTask(channelDir, "legacy");
		expect(activated?.fields.control?.version).toBe(2);
		expect((await readStoredTask(channelDir, "legacy"))?.fields.status).toBe("active");
	});
});

describe("verification parser", () => {
	it("uses the final explicit verdict only", () => {
		expect(parseVerificationVerdict("VERDICT: FAIL\nnotes\nVERDICT: PASS")).toBe("pass");
		expect(parseVerificationVerdict("looks good")).toBeUndefined();
	});
});
