import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allCases } from "../../evals/cases/index.js";
import { Admission, beginTrial, chargeableTokens } from "../../evals/harness/admission.js";
import { locateWithinRoots } from "../../evals/harness/evidence.js";
import { assertPlanIdentity, buildExecutionPlan } from "../../evals/harness/execution-plan.js";
import { EvalPool } from "../../evals/harness/pool.js";
import type { TrialContext } from "../../evals/harness/schema.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("spec 071 evidence and admission", () => {
	it("normalizes a path inside the longer known root", () => {
		const home = mkdtempSync(join(tmpdir(), "eval-071-root-"));
		roots.push(home);
		const desk = join(home, "workspace", "desk-eval");
		const located = locateWithinRoots(join(desk, "repos/billing"), [
			{ name: "workspace", dir: join(home, "workspace") },
			{ name: "desk", dir: desk },
			{ name: "home", dir: home },
		]);
		expect(located).toEqual({ root: "desk", rel: "repos/billing" });
		expect(locateWithinRoots(join(home, "..", "outside"), [{ name: "home", dir: home }])).toBeUndefined();
	});

	it("grades the journal from the frozen maintenance day, not the clock", async () => {
		const home = mkdtempSync(join(tmpdir(), "eval-071-day-"));
		roots.push(home);
		const desk = join(home, "desk");
		mkdirSync(join(desk, "journal"), { recursive: true });
		writeFileSync(join(desk, "journal/1999-01-02.md"), "ROOTCAUSE-88\n");
		const item = allCases.find((candidate) => candidate.id === "M-maint-01")!;
		const grader = item.graders.find(
			(candidate) => candidate.kind === "code" && candidate.graderId === "journal-written",
		);
		if (!grader || grader.kind !== "code") throw new Error("journal grader missing");
		const ctx: TrialContext = {
			homeDir: home,
			workspaceDir: join(home, "workspace"),
			deskDir: desk,
			deliveries: [],
			trace: [
				{
					schemaVersion: 1,
					seq: 1,
					ts: "1999-01-02T00:00:00.000Z",
					segment: 1,
					kind: "runtime-log",
					ok: true,
					fields: { observation: "maintenance-day", dayKey: "1999-01-02", evidenceEpoch: "071" },
				},
			],
			snapshot: { schemaVersion: 1, deliveries: [], fileTree: [], canaries: [], externalRequests: [] },
		};
		expect((await grader.grade(ctx)).status).toBe("pass");
		ctx.trace[0]!.fields!.dayKey = "1999-01-03";
		expect((await grader.grade(ctx)).status).toBe("fail");
	});

	it("holds two slots and does not start a third after the token cap", async () => {
		const pool = new EvalPool(2);
		const admission = new Admission({ maxTokens: 10, unknownUsage: "stop" });
		const first = await beginTrial(pool, admission);
		const second = await beginTrial(pool, admission);
		let started = false;
		const third = beginTrial(pool, admission).then((gate) => {
			started = !gate.skip;
			gate.release();
		});
		expect(started).toBe(false);
		admission.record(10);
		first.release();
		await third;
		expect(started).toBe(false);
		second.release();
		admission.record(undefined);
		const blocked = await beginTrial(pool, admission);
		expect(blocked.skip).toBe("unknown-usage");
		blocked.release();
		const local = new Admission({ maxTokens: 10 });
		local.record(0);
		expect(local.snapshot().unknown).toBe(false);
		expect(local.blockReason()).toBeUndefined();
	});

	it("counts a stopped trial's ledger and leaves a missing ledger unknown", () => {
		expect(chargeableTokens(false, 0, 0)).toBe(0);
		expect(chargeableTokens(true, 2, 37729)).toBe(37729);
		expect(chargeableTokens(true, 0, 0)).toBeUndefined();
	});

	it("refuses a stale execution plan before any model request", () => {
		const plan = buildExecutionPlan(["--case", "U-path-01"]);
		plan.identity.cases = "stale";
		expect(() => assertPlanIdentity(plan)).toThrow(/Model requests: 0/);
		expect(plan.slots).toHaveLength(1);
	});
});
