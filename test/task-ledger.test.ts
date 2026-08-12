import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatLocalTime } from "../src/shared/local-time.js";
import { createDefaultTaskControl } from "../src/tasks/control.js";
import {
	appendCurrentCycleNote,
	applyTaskPlanPatch,
	countTaskDodItems,
	isTaskActionable,
	MAX_INLINE_TASK_HISTORY_ENTRIES,
	missingStandardTaskSections,
	normalizeTaskFields,
	parseTaskFrontmatter,
	parseTaskPlan,
	readActiveTasks,
	renderStandardTaskBody,
	renderTaskDocument,
	startTaskCycle,
	taskContractSegment,
	uncheckedTaskAcceptanceItems,
} from "../src/tasks/ledger.js";
import { nextTaskWake } from "../src/tasks/task-schedule.js";

const NOW = new Date("2026-08-04T12:00:00+08:00");
const PAST = "2026-08-04T09:00:00+08:00";
const FUTURE = "2026-08-04T18:00:00+08:00";

function doc(front: string, body = "# Title\n\nbody"): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("v2 frontmatter and actionable contract", () => {
	it("canonicalizes legacy statuses without exposing terminal live states", () => {
		expect(parseTaskFrontmatter(doc("status: in-progress"))).toMatchObject({
			readable: true,
			status: "active",
			enabled: true,
			rawStatus: "in-progress",
		});
		expect(parseTaskFrontmatter(doc("status: awaiting-user"))).toMatchObject({ status: "waiting" });
		expect(parseTaskFrontmatter(doc("status: done"))).toMatchObject({
			status: "active",
			archiveOutcome: "completed",
		});
		expect(parseTaskFrontmatter(doc("status: done\nschedule: 0 9 * * 1"))).toMatchObject({ status: "sleeping" });

		const paused = parseTaskFrontmatter(doc("status: paused"));
		expect(paused).toMatchObject({ status: "active", enabled: false });
		expect(paused.control).toMatchObject({ stop: { by: "user" } });
	});

	it("fails open only for unreadable metadata and parks signal waits", () => {
		expect(parseTaskFrontmatter("not a task")).toMatchObject({ readable: false, enabled: true });
		expect(isTaskActionable({ readable: false, enabled: true }, NOW.getTime())).toBe(true);
		expect(isTaskActionable({ readable: true, enabled: false, status: "active" }, NOW.getTime())).toBe(false);
		expect(isTaskActionable({ readable: true, enabled: true, status: "active" }, NOW.getTime())).toBe(true);
		expect(isTaskActionable({ readable: true, enabled: true, status: "waiting" }, NOW.getTime())).toBe(false);
		expect(isTaskActionable({ readable: true, enabled: true, status: "waiting", wake: FUTURE }, NOW.getTime())).toBe(
			false,
		);
		expect(isTaskActionable({ readable: true, enabled: true, status: "waiting", wake: PAST }, NOW.getTime())).toBe(
			true,
		);
		expect(isTaskActionable({ readable: true, enabled: true, status: "sleeping", wake: FUTURE }, NOW.getTime())).toBe(
			false,
		);
		expect(isTaskActionable({ readable: true, enabled: true, status: "sleeping", wake: PAST }, NOW.getTime())).toBe(
			true,
		);
	});

	it("normalizes write-path combinations while preserving disabled stage and wake", () => {
		const timed = normalizeTaskFields({ status: "active", wake: FUTURE, control: createDefaultTaskControl() }, NOW);
		expect(timed).toMatchObject({ status: "waiting", wake: FUTURE, control: { waitingFor: "time" } });

		const due = normalizeTaskFields({ status: "active", wake: PAST, control: createDefaultTaskControl() }, NOW);
		expect(due).toMatchObject({ status: "active" });
		expect(due.wake).toBeUndefined();

		const parked = normalizeTaskFields(
			{ status: "waiting", control: { ...createDefaultTaskControl(), waitingFor: "time" } },
			NOW,
		);
		expect(parked.control?.waitingFor).toBe("external-signal");

		const disabled = normalizeTaskFields(
			{
				status: "sleeping",
				enabled: false,
				schedule: "0 9 * * 1",
				wake: FUTURE,
				control: { ...createDefaultTaskControl(), stop: { by: "user", reason: "maintenance", at: PAST } },
			},
			NOW,
		);
		expect(disabled).toMatchObject({ status: "sleeping", enabled: false, wake: FUTURE, schedule: "0 9 * * 1" });

		const sleeping = normalizeTaskFields({ status: "sleeping", schedule: "0 9 * * 1" }, NOW);
		expect(sleeping.wake).toBe(formatLocalTime(nextTaskWake("0 9 * * 1", NOW)!));
	});

	it("renders archive outcome without a live status", () => {
		const rendered = renderTaskDocument(
			{
				status: "active",
				outcome: "completed",
				closedAt: "2026-08-04T12:00:00+08:00",
				control: createDefaultTaskControl(),
			},
			"# Closed\n",
		);
		expect(rendered).toContain("outcome: completed");
		expect(rendered).toContain("closedAt:");
		expect(rendered).not.toContain("status:");
		expect(rendered).not.toContain("enabled:");
	});
});

describe("task body and cycle transformations", () => {
	it("renders the standard contract and checks acceptance boxes", () => {
		const body = renderStandardTaskBody({
			title: "Weekly Report",
			goal: "Publish the report.",
			dod: "- [ ] Draft reviewed\n- [ ] Published",
		});
		expect(missingStandardTaskSections(body)).toEqual([]);
		expect(uncheckedTaskAcceptanceItems(body)).toEqual(["DoD: Draft reviewed", "DoD: Published"]);
		expect(countTaskDodItems(body)).toBe(2);
		expect(taskContractSegment(body)).toContain("## Verification");
	});

	it("starts the first recurring cycle without archiving the creation placeholder", () => {
		const body = renderStandardTaskBody({ title: "Weekly", goal: "G", dod: "- [ ] Done" });
		const first = startTaskCycle(body, "cycle-2026-08-04", false);
		expect(first).toContain("## Current Cycle (cycle-2026-08-04)");
		expect(first).toContain("- Cycle started;");
		expect(first).not.toContain("### Current Cycle — closed");
		expect(first).toContain("## History");

		const progressed = appendCurrentCycleNote(first, "Built the draft.");
		const second = startTaskCycle(progressed, "cycle-2026-08-11", true);
		expect(second).toContain("## Current Cycle (cycle-2026-08-11)");
		expect(second).toContain("### Current Cycle (cycle-2026-08-04) — closed");
	});

	it("resets DoD and Plan checkboxes at a new cycle", () => {
		const body =
			"# T\n\n## DoD\n- [x] Done\n\n## Plan\n- [x] P1 build → dod:1\n- [!] P2 verify → dod:1\n- [~] P3 dropped\n\n## Current Cycle\n- complete\n\n## History\n";
		const next = startTaskCycle(body, "cycle-2", true);
		expect(next).toContain("- [ ] Done");
		expect(next).toContain("- [ ] P1 build");
		expect(next).toContain("- [ ] P2 verify");
		expect(next).toContain("- [~] P3 dropped");
	});

	it("updates Plan steps without mixing plan claims into acceptance", () => {
		const body = renderStandardTaskBody({ title: "T", goal: "G", dod: "- [ ] Done" });
		const patched = applyTaskPlanPatch(body, [{ id: "P1", status: "done", text: "Build it" }]);
		expect(patched.summary).toContain("+P1");
		expect(parseTaskPlan(patched.body)).toMatchObject({ total: 1, done: 1 });
		expect(uncheckedTaskAcceptanceItems(patched.body)).toEqual(["DoD: Done"]);
	});

	it("clips old History entries to the working-context bound", () => {
		let body = "# T\n\n## Current Cycle\n- current\n\n## History\n";
		for (let i = 0; i < MAX_INLINE_TASK_HISTORY_ENTRIES + 3; i++) body += `\n### Cycle ${i}\n- note ${i}\n`;
		const next = startTaskCycle(body, "cycle-new", true);
		expect(next).toContain("Older cycle details omitted");
	});
});

describe("readActiveTasks", () => {
	let root: string;
	let tasksDir: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "task-ledger-v2-"));
		tasksDir = join(root, "tasks");
		await mkdir(tasksDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("sorts ready work before future waits and retains disabled tasks as visible", async () => {
		await writeFile(join(tasksDir, "later.md"), doc(`status: waiting\nwake: ${FUTURE}`, "# Later"));
		await writeFile(join(tasksDir, "now.md"), doc("status: active", "# Now"));
		await writeFile(join(tasksDir, "stopped.md"), doc("status: active\nenabled: false", "# Stopped"));
		const entries = await readActiveTasks(tasksDir, NOW.getTime());
		expect(entries.map((entry) => entry.id)).toEqual(["now", "later", "stopped"]);
		expect(entries.find((entry) => entry.id === "stopped")?.frontmatter.enabled).toBe(false);
	});

	it("returns an actionable repair entry for unreadable frontmatter", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		const [entry] = await readActiveTasks(tasksDir, NOW.getTime());
		expect(entry).toMatchObject({ id: "broken", actionable: true, frontmatter: { readable: false } });
	});
});
