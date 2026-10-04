import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyTaskItemsPatch,
	findTaskItem,
	parseTaskItems,
	readActiveTasks,
	renderStandardTaskBody,
	renderTaskDocument,
	uncheckedTaskAcceptanceItems,
} from "../src/tasks/ledger.js";
import type { Ticket } from "../src/tasks/ticket.js";

const NOW = new Date("2026-09-05T10:00:00+08:00");
const FUTURE: Ticket = { kind: "time", at: "2026-09-06T10:00:00+08:00", by: "2026-09-06T10:00:00+08:00" };
const STALE: Ticket = { kind: "time", at: "2026-09-04T10:00:00+08:00", by: "2026-09-04T10:00:00+08:00" };

describe("task contract body (spec 052, §3.4)", () => {
	it("renders Goal, DoD and numbered Work Items — and nothing the runtime would later rewrite", () => {
		const body = renderStandardTaskBody({
			title: "Weekly Report",
			goal: "Publish the report.",
			dod: "- [ ] Draft reviewed\n- [ ] Published",
			items: [{ text: "Collect material" }, { text: "Draft it" }],
		});
		expect(uncheckedTaskAcceptanceItems(body)).toEqual(["DoD: Draft reviewed", "DoD: Published"]);
		expect(parseTaskItems(body)?.items.map((item) => [item.id, item.text])).toEqual([
			["W1", "Collect material"],
			["W2", "Draft it"],
		]);
		for (const retired of ["## Manual", "## Verification", "## Plan", "上次结果", "## History"]) {
			expect(body).not.toContain(retired);
		}
	});

	it("flags a DoD written as prose, which would otherwise read as 'nothing left to check'", () => {
		expect(uncheckedTaskAcceptanceItems("## DoD\nIt works.\n")[0]).toContain("no checklist items");
	});

	it("derives the current item and ignores dropped ones in the totals", () => {
		const items = parseTaskItems("## Work Items\n- [x] W1 a\n- [!] W2 b\n- [~] W3 c\n- [ ] W4 d\n");
		expect(items).toMatchObject({ total: 3, done: 1 });
		expect(items?.current?.id).toBe("W2");
	});

	it("accepts a converted task's P-numbered items", () => {
		const items = parseTaskItems("## Work Items\n- [ ] P1 first → dod:1\n");
		expect(items?.items[0]).toMatchObject({ id: "P1", dodRefs: [1] });
		expect(findTaskItem("## Work Items\n- [ ] P1 first\n", "p1")?.id).toBe("P1");
	});

	it("creates the section on the first patch, patches in place, and requires text for a new id", () => {
		const body = renderStandardTaskBody({ title: "T", goal: "G", dod: "- [ ] Done" });
		const created = applyTaskItemsPatch(body, [{ id: "W1", text: "Build it" }]);
		expect(created.summary).toContain("+W1");
		const done = applyTaskItemsPatch(created.body, [{ id: "W1", status: "done" }]);
		expect(parseTaskItems(done.body)).toMatchObject({ total: 1, done: 1 });
		expect(uncheckedTaskAcceptanceItems(done.body)).toEqual(["DoD: Done"]);
		expect(() => applyTaskItemsPatch(done.body, [{ id: "W9" }])).toThrow(/requires text/);
	});
});

describe("readActiveTasks", () => {
	let root: string;
	let tasksDir: string;

	const doc = (fields: Parameters<typeof renderTaskDocument>[0], body: string) => renderTaskDocument(fields, body);

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "task-ledger-"));
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
		// An expired park is work the runtime owes an answer for, so it must outrank an ordinary one.
		expect(entries.find((entry) => entry.id === "overdue")?.expired).toBe(true);
		expect(entries.find((entry) => entry.id === "later")?.expired).toBe(false);
		expect(entries.find((entry) => entry.id === "stopped")?.runnable).toBe(false);
	});

	it("returns a runnable repair entry for unreadable frontmatter", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		const [entry] = await readActiveTasks(tasksDir, NOW.getTime());
		expect(entry).toMatchObject({ id: "broken", runnable: true, readable: false });
	});

	it("never runs a file still carrying v3 lines, and flags it for /tasks doctor", async () => {
		// An unconverted v3 task (here: disabled, asleep until 2099) must not start executing as a fresh v5 task.
		await writeFile(
			join(tasksDir, "old.md"),
			"---\nstatus: sleeping\nenabled: false\nwake: 2099-01-01T08:00:00+08:00\nschedule: 0 9 * * 1\n---\n# Old\n",
		);
		const [entry] = await readActiveTasks(tasksDir, NOW.getTime());
		expect(entry).toMatchObject({ id: "old", legacy: true, readable: true, runnable: false });
	});
});
