import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderTaskDocument } from "../src/shared/task-ledger.js";
import {
	applyTaskControlPatch,
	createDefaultTaskControl,
	invalidateTaskApproval,
	parseTaskControl,
	taskBudgetViolation,
} from "../src/tasks/control.js";
import { claimTaskAttempt, finishTaskAttempt, readStoredTask } from "../src/tasks/store.js";
import { parseVerificationVerdict } from "../src/tasks/verification.js";

describe("task control", () => {
	it("round-trips governed metadata and derives external approval requirements", () => {
		const control = applyTaskControlPatch(createDefaultTaskControl(), {
			priority: "critical",
			nextAction: "Run integration tests",
			sideEffects: "external",
			maxAttempts: 4,
			maxTokens: 10_000,
		});
		expect(control.externalApproval).toBe("required");
		expect(parseTaskControl(JSON.stringify(control))).toEqual(control);
	});

	it("reports the first deterministic deadline or cumulative budget violation", () => {
		const control = createDefaultTaskControl();
		control.deadline = "2026-07-10T00:00:00.000Z";
		expect(taskBudgetViolation(control, Date.parse("2026-07-11T00:00:00.000Z"))).toContain("deadline exceeded");
		control.deadline = undefined;
		control.budget.maxTokens = 100;
		control.usage.tokens = 100;
		expect(taskBudgetViolation(control, 0)).toContain("token budget exhausted");
	});

	it("rejects malformed governance instead of silently applying defaults", () => {
		const control = createDefaultTaskControl();
		expect(() => parseTaskControl(JSON.stringify({ ...control, deadline: "someday" }))).toThrow(/deadline/);
		expect(() => parseTaskControl(JSON.stringify({ ...control, dependsOn: ["../escape"] }))).toThrow(/task id/);
		expect(() => parseTaskControl(JSON.stringify({ ...control, priority: "urgent" }))).toThrow(/enum value/);
	});

	it("invalidates an external approval when the governed action changes", () => {
		const control = createDefaultTaskControl();
		control.sideEffects = "external";
		control.externalApproval = "granted";
		control.approvalBy = "Alice";
		control.approvedAt = "2026-07-10T00:00:00.000Z";
		control.approvalBodyHash = "a".repeat(64);
		expect(invalidateTaskApproval(control)).toMatchObject({
			externalApproval: "required",
			approvalBy: undefined,
			approvedAt: undefined,
			approvalBodyHash: undefined,
		});
	});

	it("uses the verifier's final explicit marker", () => {
		expect(parseVerificationVerdict("VERDICT: FAIL\nnotes\nVERDICT: PASS")).toBe("pass");
		expect(parseVerificationVerdict("looks good")).toBeUndefined();
	});
});

describe("task attempt accounting", () => {
	let channelDir: string;
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "task-control-"));
		channelDir = join(root, "dm_1");
		await mkdir(join(channelDir, "tasks", "archive"), { recursive: true });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("claims before a run and accounts usage even when the task was archived during that run", async () => {
		const path = join(channelDir, "tasks", "work.md");
		await writeFile(path, renderTaskDocument({ status: "open", control: createDefaultTaskControl() }, "# Work\n"));
		await claimTaskAttempt(channelDir, "work", new Date("2026-07-10T00:00:00.000Z"));
		await rename(path, join(channelDir, "tasks", "archive", "work.md"));
		await finishTaskAttempt(channelDir, "work", {
			tokens: 123.9,
			costUsd: 0.45,
			wallTimeMinutes: 2.5,
			failed: false,
			finishedAt: new Date("2026-07-10T00:03:00.000Z"),
		});
		const stored = await readStoredTask(channelDir, "work", true);
		expect(stored?.fields.control?.usage).toEqual({ attempts: 1, tokens: 123, costUsd: 0.45, wallTimeMinutes: 2.5 });
		expect(await readFile(stored!.path, "utf-8")).toContain('"lastFinishedAt":"2026-07-10T00:03:00.000Z"');
	});
});
