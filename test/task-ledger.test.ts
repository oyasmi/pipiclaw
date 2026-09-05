import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openCycleBody, readLastResult, writeLastResult } from "../src/tasks/cycle.js";
import {
	applyTaskPlanPatch,
	countTaskDodItems,
	missingStandardTaskSections,
	parseTaskPlan,
	readActiveTasks,
	renderStandardTaskBody,
	renderTaskDocument,
	taskContractSegment,
	uncheckedTaskAcceptanceItems,
} from "../src/tasks/ledger.js";
import type { Ticket } from "../src/tasks/ticket.js";

const NOW = new Date("2026-09-05T10:00:00+08:00");
const FUTURE: Ticket = { kind: "time", at: "2026-09-06T10:00:00+08:00", by: "2026-09-06T10:00:00+08:00" };
const STALE: Ticket = { kind: "time", at: "2026-09-04T10:00:00+08:00", by: "2026-09-04T10:00:00+08:00" };

describe("task contract body (spec 051, D5)", () => {
	it("renders a contract with no cycle log or history section", () => {
		const body = renderStandardTaskBody({
			title: "Weekly Report",
			goal: "Publish the report.",
			dod: "- [ ] Draft reviewed\n- [ ] Published",
		});
		expect(missingStandardTaskSections(body)).toEqual([]);
		expect(uncheckedTaskAcceptanceItems(body)).toEqual(["DoD: Draft reviewed", "DoD: Published"]);
		expect(countTaskDodItems(body)).toBe(2);
		// The per-step record lives in `<id>.jsonl` now; the contract carries none of it.
		expect(body).not.toContain("## Current Cycle");
		expect(body).not.toContain("## History");
	});

	it("ends the verification-bound contract segment before Plan and before 上次结果", () => {
		const body = renderStandardTaskBody({
			title: "T",
			goal: "G",
			dod: "- [ ] Done",
			plan: "Build it",
		});
		const withResult = writeLastResult(body, "- c-1 完成：shipped");
		const segment = taskContractSegment(withResult);
		expect(segment).toContain("## Verification");
		// Revising the means, or recording what happened last cycle, must not invalidate a PASS.
		expect(segment).not.toContain("## Plan");
		expect(segment).not.toContain("上次结果");
		expect(taskContractSegment(withResult)).toBe(taskContractSegment(body));
	});

	it("overwrites 上次结果 rather than appending a second one", () => {
		let body = renderStandardTaskBody({ title: "T", goal: "G", dod: "- [ ] Done" });
		body = writeLastResult(body, "- first");
		body = writeLastResult(body, "- second");
		expect(body.match(/## 上次结果/g)?.length).toBe(1);
		expect(readLastResult(body)).toBe("- second");
	});

	it("clips an over-long 上次结果 and points at the full record", () => {
		const body = writeLastResult(
			renderStandardTaskBody({ title: "T", goal: "G", dod: "- [ ] D" }),
			"x".repeat(5_000),
		);
		expect(readLastResult(body)?.length).toBeLessThan(1_400);
		expect(readLastResult(body)).toContain("task_log");
	});

	it("resets DoD and Plan checkboxes for a recurring cycle but leaves dropped steps dropped", () => {
		const body = "# T\n\n## DoD\n- [x] Done\n\n## Plan\n- [x] P1 build → dod:1\n- [!] P2 verify\n- [~] P3 dropped\n";
		const next = openCycleBody(body, true);
		expect(next).toContain("- [ ] Done");
		expect(next).toContain("- [ ] P1 build");
		expect(next).toContain("- [ ] P2 verify");
		// A step that was deliberately abandoned must not be resurrected by the next occurrence.
		expect(next).toContain("- [~] P3 dropped");
		// A one-shot task's Plan is its only agenda; unchecking it would erase real progress.
		expect(openCycleBody(body, false)).toBe(body);
	});

	it("creates the Plan section on the first patch, without touching acceptance", () => {
		const body = renderStandardTaskBody({ title: "T", goal: "G", dod: "- [ ] Done" });
		const patched = applyTaskPlanPatch(body, [{ id: "P1", status: "done", text: "Build it" }]);
		expect(patched.summary).toContain("+P1");
		expect(parseTaskPlan(patched.body)).toMatchObject({ total: 1, done: 1 });
		expect(uncheckedTaskAcceptanceItems(patched.body)).toEqual(["DoD: Done"]);
	});
});

describe("readActiveTasks", () => {
	let root: string;
	let tasksDir: string;

	const doc = (fields: Parameters<typeof renderTaskDocument>[0], body: string) => renderTaskDocument(fields, body);

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "task-ledger-v4-"));
		tasksDir = join(root, "tasks");
		await mkdir(tasksDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("sorts runnable work first, then expired parks, then paused tasks", async () => {
		await writeFile(join(tasksDir, "later.md"), doc({ state: "parked", ticket: FUTURE }, "# Later"));
		await writeFile(join(tasksDir, "now.md"), doc({ state: "open" }, "# Now"));
		await writeFile(join(tasksDir, "overdue.md"), doc({ state: "parked", ticket: STALE }, "# Overdue"));
		await writeFile(
			join(tasksDir, "stopped.md"),
			doc({ state: "open", paused: { by: "user", reason: "hold", at: "2026-01-01T00:00:00+08:00" } }, "# Stopped"),
		);

		const entries = await readActiveTasks(tasksDir, NOW.getTime());
		expect(entries.map((entry) => entry.id)).toEqual(["now", "overdue", "later", "stopped"]);
		// An expired park is work the runtime owes an answer for, so it must outrank an ordinary
		// park even when a channel has more ready candidates than one tick can carry (D2-INV).
		expect(entries.find((entry) => entry.id === "overdue")?.expired).toBe(true);
		expect(entries.find((entry) => entry.id === "later")?.expired).toBe(false);
		expect(entries.find((entry) => entry.id === "stopped")?.runnable).toBe(false);
	});

	it("returns a runnable repair entry for unreadable frontmatter", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		const [entry] = await readActiveTasks(tasksDir, NOW.getTime());
		expect(entry).toMatchObject({ id: "broken", runnable: true, readable: false });
	});

	it("flags a v3 file as legacy so the driver dispatches it repair-only", async () => {
		await writeFile(
			join(tasksDir, "old.md"),
			'---\nstatus: active\nenabled: true\ncontrol: {"version":3}\n---\n# Old\n',
		);
		const [entry] = await readActiveTasks(tasksDir, NOW.getTime());
		expect(entry).toMatchObject({ id: "old", legacy: true, runnable: true });
	});
});
