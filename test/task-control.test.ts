import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyTaskControlPatch,
	createDefaultTaskControl,
	invalidateTaskApproval,
	parseTaskControl,
	resetTaskControlForCycle,
	taskBudgetViolation,
} from "../src/tasks/control.js";
import { renderTaskDocument } from "../src/tasks/ledger.js";
import { withTaskMutation } from "../src/tasks/mutation-lock.js";
import {
	claimTaskAttempt,
	finishTaskAttempt,
	readStoredTask,
	releaseTaskAttemptClaim,
	updateStoredTask,
} from "../src/tasks/store.js";
import { parseVerificationVerdict } from "../src/tasks/verification.js";

describe("task control", () => {
	it("round-trips governed metadata and derives external approval requirements", () => {
		const control = applyTaskControlPatch(createDefaultTaskControl(), {
			priority: "critical",
			nextAction: "Run integration tests",
			sideEffects: "external",
			maxAttempts: 4,
		});
		expect(control.externalApproval).toBe("required");
		expect(parseTaskControl(JSON.stringify(control))).toEqual(control);
	});

	it("reads retired enum values back as their canonical replacement", () => {
		const control = parseTaskControl(
			JSON.stringify({
				...createDefaultTaskControl(),
				// Written by an older build: `isolation` enforced nothing, the read-only/workspace
				// split gated nothing, and actions used to stamp their own outcomes.
				isolation: "worktree",
				sideEffects: "read-only",
				lastOutcome: "verified",
			}),
		);
		expect(control.sideEffects).toBe("workspace");
		expect(control.lastOutcome).toBe("progress");
		expect(control).not.toHaveProperty("isolation");
	});

	it("defaults the claim generation when reading pre-generation control metadata", () => {
		const legacy = createDefaultTaskControl();
		const { attemptGeneration: _generation, ...stored } = legacy;
		expect(parseTaskControl(JSON.stringify(stored)).attemptGeneration).toBe(0);
	});

	// Spec 036 D8: retired keys written by an older build are ignored on read rather than
	// failing the parse, so stored tasks stay readable with no migration script.
	it("ignores retired budget, ledger and worktree keys written by an older build", () => {
		const control = parseTaskControl(
			JSON.stringify({
				...createDefaultTaskControl(),
				budget: { maxAttempts: 5, maxTokens: 100, maxCostUsd: 1, maxWallTimeMinutes: 30 },
				lifetimeUsage: { attempts: 9, tokens: 900, costUsd: 3, costKnown: true, wallTimeMinutes: 40 },
				worktree: { path: "/tmp/wt", branch: "pipiclaw-task/ship/abc" },
			}),
		);
		expect(control.budget).toEqual({ maxAttempts: 5 });
		expect(control).not.toHaveProperty("lifetimeUsage");
		expect(control).not.toHaveProperty("worktree");
	});

	// Spec 036 D5/D8: the retired `mode` enum maps losslessly onto the boolean — `independent`
	// was the only form that gated `done`, `evidence` was maker self-certification.
	it("maps the retired verification mode onto the required boolean", () => {
		const base = createDefaultTaskControl();
		const independent = parseTaskControl(
			JSON.stringify({ ...base, verification: { mode: "independent", status: "passed" } }),
		);
		const evidence = parseTaskControl(
			JSON.stringify({ ...base, verification: { mode: "evidence", status: "passed" } }),
		);
		expect(independent.verification.required).toBe(true);
		expect(evidence.verification.required).toBe(false);
		expect(independent.verification).not.toHaveProperty("mode");
	});

	// Spec 036 D5: under unattended operation the tasks that touch outside systems are exactly
	// the ones nobody reviews, so they demand independent acceptance unless explicitly waived.
	it("requires independent verification once a task gains external side effects", () => {
		const control = applyTaskControlPatch(createDefaultTaskControl(), { sideEffects: "external" });
		expect(control.verification.required).toBe(true);

		const waived = applyTaskControlPatch(createDefaultTaskControl(), {
			sideEffects: "external",
			verificationRequired: false,
		});
		expect(waived.verification.required).toBe(false);
	});

	it("reports the first deterministic deadline or attempt violation", () => {
		const control = createDefaultTaskControl();
		control.deadline = "2026-07-10T00:00:00.000Z";
		expect(taskBudgetViolation(control, Date.parse("2026-07-11T00:00:00.000Z"))).toContain("deadline exceeded");
		control.deadline = undefined;
		control.usage.attempts = control.budget.maxAttempts;
		expect(taskBudgetViolation(control, 0)).toContain("attempt budget exhausted");
	});

	// Spec 036 D1: token/cost/wall-time budgets are gone; usage still measures all four
	// dimensions, but only attempts (and the deadline) can stop a task.
	it("no longer enforces token, cost or wall-time budgets", () => {
		const control = createDefaultTaskControl();
		control.usage.tokens = 10_000_000;
		control.usage.costUsd = 999;
		control.usage.costKnown = false;
		control.usage.wallTimeMinutes = 10_000;
		expect(taskBudgetViolation(control, 0)).toBeUndefined();
	});

	it("rejects malformed governance instead of silently applying defaults", () => {
		const control = createDefaultTaskControl();
		expect(() => parseTaskControl(JSON.stringify({ ...control, deadline: "someday" }))).toThrow(/deadline/);
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

	it("preserves an explicit external approval exemption across patches and cycles", () => {
		const control = applyTaskControlPatch(createDefaultTaskControl(), {
			sideEffects: "external",
			externalApproval: "not-required",
		});
		expect(applyTaskControlPatch(control, { nextAction: "Wait for the scheduled run" }).externalApproval).toBe(
			"not-required",
		);
		expect(resetTaskControlForCycle(control, "2026-W29").externalApproval).toBe("not-required");
	});

	it("resets cycle usage", () => {
		const control = createDefaultTaskControl();
		control.usage = { attempts: 2, tokens: 100, costUsd: 0, costKnown: false, wallTimeMinutes: 3 };
		const reset = resetTaskControlForCycle(control, "cycle-2");
		expect(reset.usage).toEqual({ attempts: 0, tokens: 0, costUsd: 0, costKnown: true, wallTimeMinutes: 0 });
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
			costKnown: true,
			wallTimeMinutes: 2.5,
			failed: false,
			finishedAt: new Date("2026-07-10T00:03:00.000Z"),
		});
		const stored = await readStoredTask(channelDir, "work", true);
		expect(stored?.fields.control?.usage).toEqual({
			attempts: 1,
			tokens: 123,
			costUsd: 0.45,
			costKnown: true,
			wallTimeMinutes: 2.5,
		});
		expect(await readFile(stored!.path, "utf-8")).toContain('"lastFinishedAt":"2026-07-10T08:03:00.000+08:00"');
	});

	it("does not charge an attempt to a silent driver run while retaining its usage audit", async () => {
		const path = join(channelDir, "tasks", "quiet.md");
		await writeFile(path, renderTaskDocument({ status: "open", control: createDefaultTaskControl() }, "# Quiet\n"));
		await claimTaskAttempt(channelDir, "quiet", new Date("2026-07-10T00:00:00.000Z"));
		await finishTaskAttempt(channelDir, "quiet", {
			tokens: 42,
			costUsd: 0.01,
			costKnown: true,
			wallTimeMinutes: 0.5,
			failed: false,
			silent: true,
			finishedAt: new Date("2026-07-10T00:01:00.000Z"),
		});
		const stored = await readStoredTask(channelDir, "quiet");
		expect(stored?.fields.control).toMatchObject({
			lastOutcome: "pending",
			usage: { attempts: 0, tokens: 42, costUsd: 0.01, costKnown: true, wallTimeMinutes: 0.5 },
		});
	});

	it("does not let an older failed dispatch release a newer claim with the same timestamp", async () => {
		const path = join(channelDir, "tasks", "claimed.md");
		await writeFile(
			path,
			renderTaskDocument({ status: "active", control: createDefaultTaskControl() }, "# Claimed\n"),
		);
		const now = new Date("2026-07-10T00:00:00.000Z");
		const first = await claimTaskAttempt(channelDir, "claimed", now);
		const second = await claimTaskAttempt(channelDir, "claimed", now);
		expect(first?.generation).toBe(1);
		expect(second?.generation).toBe(2);

		await releaseTaskAttemptClaim(channelDir, "claimed", first!);
		expect((await readStoredTask(channelDir, "claimed"))?.fields.control).toMatchObject({
			attemptGeneration: 2,
			lastOutcome: "running",
			usage: { attempts: 2 },
		});

		await releaseTaskAttemptClaim(channelDir, "claimed", second!);
		expect((await readStoredTask(channelDir, "claimed"))?.fields.control).toMatchObject({
			attemptGeneration: 2,
			lastOutcome: "running",
			usage: { attempts: 1 },
		});
	});

	it("does not let a stale claim's finish overwrite a newer claim's outcome (H-1)", async () => {
		const path = join(channelDir, "tasks", "overlap.md");
		await writeFile(
			path,
			renderTaskDocument({ status: "active", control: createDefaultTaskControl() }, "# Overlap\n"),
		);
		const now = new Date("2026-07-10T00:00:00.000Z");
		const first = await claimTaskAttempt(channelDir, "overlap", now);
		const second = await claimTaskAttempt(channelDir, "overlap", now);
		expect(first?.generation).toBe(1);
		expect(second?.generation).toBe(2);

		// The stale (gen 1) turn's completion is delivered after the newer (gen 2) claim already
		// marked the task "running" again. Its usage still counts, but it must not clobber the
		// task's outcome/blockedReason/lastFinishedAt out from under the still-in-flight gen-2 attempt.
		await finishTaskAttempt(channelDir, "overlap", {
			tokens: 10,
			costUsd: 0.01,
			costKnown: true,
			wallTimeMinutes: 1,
			failed: true,
			finishedAt: new Date("2026-07-10T00:05:00.000Z"),
			generation: first!.generation,
		});
		const afterStaleFinish = (await readStoredTask(channelDir, "overlap"))?.fields.control;
		expect(afterStaleFinish).toMatchObject({
			attemptGeneration: 2,
			lastOutcome: "running",
			blockedReason: undefined,
			usage: { attempts: 2, tokens: 10, costUsd: 0.01, wallTimeMinutes: 1 },
		});
		expect(afterStaleFinish?.lastFinishedAt).toBeUndefined();

		// The real (gen 2) finish still applies normally.
		await finishTaskAttempt(channelDir, "overlap", {
			tokens: 5,
			costUsd: 0.02,
			costKnown: true,
			wallTimeMinutes: 2,
			failed: false,
			finishedAt: new Date("2026-07-10T00:06:00.000Z"),
			generation: second!.generation,
		});
		const afterRealFinish = (await readStoredTask(channelDir, "overlap"))?.fields.control;
		expect(afterRealFinish).toMatchObject({
			attemptGeneration: 2,
			lastOutcome: "progress",
			blockedReason: undefined,
			usage: { attempts: 2, tokens: 15, costUsd: 0.03, wallTimeMinutes: 3 },
		});
		expect(afterRealFinish?.lastFinishedAt).toBe("2026-07-10T08:06:00.000+08:00");
	});

	it("serializes lower-level task updates behind an existing task mutation", async () => {
		const path = join(channelDir, "tasks", "serial.md");
		await writeFile(
			path,
			renderTaskDocument({ status: "active", control: createDefaultTaskControl() }, "# Serial\n"),
		);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const blocker = withTaskMutation(channelDir, "serial", () => held);
		let updated = false;
		const update = updateStoredTask(channelDir, "serial", (task) => {
			task.fields.control!.usage.attempts++;
			updated = true;
		});
		await Promise.resolve();
		expect(updated).toBe(false);
		release();
		await Promise.all([blocker, update]);
		expect((await readStoredTask(channelDir, "serial"))?.fields.control?.usage.attempts).toBe(1);
	});
});
