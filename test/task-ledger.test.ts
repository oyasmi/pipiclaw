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
} from "../src/tasks/contract.js";

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

	it("lists what is happening first, then what waits on the user, then the rest — oldest project first within a state", async () => {
		const since = "2026-09-05T10:00:00+08:00";
		const usage = (startedAt: string) => ({ startedAt, steps: 0, usd: 0, usdEstimated: false });
		await writeFile(
			join(tasksDir, "stopped.md"),
			doc({ state: "paused", paused: { by: "user", reason: "hold", at: since } }, "# Stopped"),
		);
		await writeFile(
			join(tasksDir, "later.md"),
			doc({ state: "waiting", waiting: { kind: "time", until: since, since } }, "# Later"),
		);
		await writeFile(
			join(tasksDir, "young.md"),
			doc({ state: "queued", usage: usage("2026-09-05T09:00:00+08:00") }, "# Young"),
		);
		await writeFile(
			join(tasksDir, "old.md"),
			doc({ state: "queued", usage: usage("2026-09-01T09:00:00+08:00") }, "# Old"),
		);
		await writeFile(
			join(tasksDir, "asks.md"),
			doc({ state: "waiting", waiting: { kind: "user", question: "q", since } }, "# Asks"),
		);
		await writeFile(
			join(tasksDir, "results.md"),
			doc({ state: "waiting", waiting: { kind: "work", since } }, "# Results"),
		);
		await writeFile(join(tasksDir, "now.md"), doc({ state: "running" }, "# Now"));

		const entries = await readActiveTasks(tasksDir);
		expect(entries.map((entry) => entry.id)).toEqual(["now", "asks", "results", "old", "young", "later", "stopped"]);
	});

	it("lists a task with unreadable frontmatter, flagged, rather than hiding it", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		const [entry] = await readActiveTasks(tasksDir);
		expect(entry).toMatchObject({ id: "broken", readable: false });
	});
});
