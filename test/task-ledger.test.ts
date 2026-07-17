import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	appendCurrentCycleNote,
	extractTaskTitle,
	isTaskActionable,
	missingStandardTaskSections,
	normalizeTaskId,
	parseTaskFrontmatter,
	readActiveTasks,
	renderStandardTaskBody,
	startTaskCycle,
	taskBody,
	uncheckedTaskAcceptanceItems,
} from "../src/shared/task-ledger.js";

const NOW = Date.parse("2026-07-08T12:00:00+08:00");
const PAST = "2026-07-08T09:00:00+08:00";
const FUTURE = "2026-07-08T18:00:00+08:00";

function doc(front: string, body = "# Title\n\nbody"): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("parseTaskFrontmatter", () => {
	it("reads the three known flat fields", () => {
		const fm = parseTaskFrontmatter(doc("status: in-progress\nwake: 2026-07-08T14:00:00+08:00\nrecurrence: 每周一"));
		expect(fm).toEqual({
			readable: true,
			status: "in-progress",
			wake: "2026-07-08T14:00:00+08:00",
			recurrence: "每周一",
		});
	});

	it("marks content without a leading --- as unreadable", () => {
		expect(parseTaskFrontmatter("no frontmatter here").readable).toBe(false);
	});

	it("marks content with an unterminated frontmatter block as unreadable", () => {
		expect(parseTaskFrontmatter("---\nstatus: open\n(no closing)").readable).toBe(false);
	});
});

describe("isTaskActionable (frontmatter contract)", () => {
	it("done is never actionable", () => {
		expect(isTaskActionable({ readable: true, status: "done" }, NOW)).toBe(false);
	});
	it("paused is never actionable", () => {
		expect(isTaskActionable({ readable: true, status: "paused" }, NOW)).toBe(false);
	});
	it("non-done with no wake is actionable", () => {
		expect(isTaskActionable({ readable: true, status: "in-progress" }, NOW)).toBe(true);
	});
	it("non-done with a future wake is not actionable", () => {
		expect(isTaskActionable({ readable: true, status: "blocked", wake: FUTURE }, NOW)).toBe(false);
	});
	it("non-done with a past wake is actionable", () => {
		expect(isTaskActionable({ readable: true, status: "awaiting-user", wake: PAST }, NOW)).toBe(true);
	});
	it("an unparseable wake does not defer (treated as unset)", () => {
		expect(isTaskActionable({ readable: true, status: "open", wake: "not a date" }, NOW)).toBe(true);
	});
	it("unreadable frontmatter is fail-open (actionable)", () => {
		expect(isTaskActionable({ readable: false }, NOW)).toBe(true);
	});
});

describe("extractTaskTitle / taskBody", () => {
	it("takes the first heading after frontmatter", () => {
		expect(extractTaskTitle(doc("status: open", "# 周报编写\n\ndetail"), "id")).toBe("周报编写");
	});
	it("falls back to the id when there is no heading", () => {
		expect(extractTaskTitle(doc("status: open", "no heading"), "my-id")).toBe("my-id");
	});
	it("returns the verbatim body after the frontmatter (blank line included)", () => {
		expect(taskBody("---\nstatus: open\n---\n\n# H\nline")).toBe("\n# H\nline");
	});
	it("returns the whole content when there is no frontmatter", () => {
		expect(taskBody("# H\nline")).toBe("# H\nline");
	});
});

describe("normalizeTaskId", () => {
	it("strips a .md suffix", () => {
		expect(normalizeTaskId("weekly-report.md")).toBe("weekly-report");
	});
	it.each(["../escape", "a/b", ".", "..", "bad name"])("rejects %s", (id) => {
		expect(() => normalizeTaskId(id)).toThrow(/Invalid task id/);
	});
});

describe("standard task skeleton", () => {
	it("renders all required standard sections", () => {
		const body = renderStandardTaskBody({
			title: "Weekly Report",
			goal: "Publish the weekly report.",
			dod: "- [ ] Draft reviewed\n- [ ] Published",
		});
		expect(missingStandardTaskSections(body)).toEqual([]);
		expect(body).toContain("## Goal");
		expect(body).toContain("## DoD");
		expect(body).toContain("## Manual");
		expect(body).toContain("## Current Cycle");
		expect(body).toContain("## History");
	});

	it("accepts Chinese section aliases", () => {
		const body =
			"# 周报\n\n## 目标\nx\n\n## DoD\nx\n\n## 手册\nx\n\n## 验收\nx\n\n## 当前周期（2026-W28）\nx\n\n## 历史\nx";
		expect(missingStandardTaskSections(body)).toEqual([]);
	});

	it("finds unchecked acceptance boxes only in DoD and Verification", () => {
		const body =
			"# T\n\n## DoD\n- [x] built\n- [ ] tested\n\n## Verification\n- [ ] reviewer passed\n\n## Current Cycle\n- [ ] not acceptance";
		expect(uncheckedTaskAcceptanceItems(body)).toEqual(["DoD: tested", "Verification: reviewer passed"]);
	});

	// Regression: a DoD with no checkbox syntax at all (numbered list, prose) used to
	// make this return an empty array — indistinguishable from "everything checked" —
	// letting candidate/done through with nothing ever actually verified.
	it("flags a DoD with content but no checklist items at all", () => {
		const body =
			"# T\n\n## DoD\n1. Draft reviewed\n2. Published\n\n## Verification\nMode: independent\n- Spot check.";
		expect(uncheckedTaskAcceptanceItems(body)).toEqual([
			'DoD has no checklist items — rewrite it as "- [ ] ..." acceptance items before requesting verification or done.',
		]);
	});

	it("does not flag a Verification section that is prose-only by design", () => {
		const body = "# T\n\n## DoD\n- [x] built\n\n## Verification\nMode: independent\n- Spot check the artifact.";
		expect(uncheckedTaskAcceptanceItems(body)).toEqual([]);
	});

	it("does not flag an empty DoD section", () => {
		const body = "# T\n\n## DoD\n\n## Verification\nMode: independent";
		expect(uncheckedTaskAcceptanceItems(body)).toEqual([]);
	});

	it("appends progress inside Current Cycle without disturbing History", () => {
		const body = renderStandardTaskBody({ title: "T", goal: "G", dod: "- [ ] D" });
		const updated = appendCurrentCycleNote(body, "Tests pass; next step: review.");
		expect(updated).toContain(
			"- Created; next step: start work and append progress here before ending each turn.\n- Tests pass; next step: review.\n\n## History",
		);
	});

	it("starts a new cycle without appending future notes to the closed cycle", () => {
		const body = renderStandardTaskBody({ title: "Weekly", goal: "G", dod: "- [ ] D" }).replace(
			"- Created; next step: start work and append progress here before ending each turn.",
			"- Published the previous report.",
		);
		const next = startTaskCycle(body, "2026-W29");
		expect(next).toContain("## Current Cycle (2026-W29)");
		expect(next).toContain("### Current Cycle — closed");
		expect(next).toContain("- Published the previous report.");
		expect(appendCurrentCycleNote(next, "Started collecting inputs.")).toContain("- Started collecting inputs.");
	});

	// Regression: startTaskCycle archived the closed cycle's log but left the DoD/Verification
	// checkboxes as-is. A periodic task that finished cycle 1 fully checked would open cycle 2
	// with uncheckedTaskAcceptanceItems() reporting zero unchecked items — the acceptance gate
	// silently passing on stale evidence from a cycle that no longer exists.
	it("unchecks DoD/Verification boxes left over from the closed cycle", () => {
		const body = renderStandardTaskBody({
			title: "Weekly",
			goal: "G",
			dod: "- [x] cycle 1 done",
			verificationPlan: "- [x] cycle 1 spot check",
		});
		const next = startTaskCycle(body, "2026-W29");
		expect(next).toContain("- [ ] cycle 1 done");
		expect(next).toContain("- [ ] cycle 1 spot check");
		expect(next).not.toContain("[x]");
		expect(uncheckedTaskAcceptanceItems(next)).toEqual(["DoD: cycle 1 done", "Verification: cycle 1 spot check"]);
	});

	it("rejects progress updates when the task has no Current Cycle section", () => {
		expect(() => appendCurrentCycleNote("# T\n\nbody", "progress")).toThrow(/normalize the task skeleton/);
	});

	it("normalizes a multiline progress note to one safe bullet", () => {
		const body = "# T\n\n## Current Cycle (cycle-1)\n- first\n\n## History\n";
		const updated = appendCurrentCycleNote(body, "second line\nnext step");
		expect(updated).toContain("- second line next step\n\n## History");
	});
});

describe("readActiveTasks", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "task-ledger-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns empty for a missing directory", async () => {
		expect(await readActiveTasks(join(dir, "nope"), NOW)).toEqual([]);
	});

	it("skips the archive/ subdirectory and non-.md files", async () => {
		await writeFile(join(dir, "a.md"), doc("status: open"));
		await writeFile(join(dir, "notes.txt"), "ignore me");
		await mkdir(join(dir, "archive"), { recursive: true });
		await writeFile(join(dir, "archive", "old.md"), doc("status: done"));
		const ids = (await readActiveTasks(dir, NOW)).map((entry) => entry.id);
		expect(ids).toEqual(["a"]);
	});

	it("sorts actionable-first, then by wake ascending", async () => {
		await writeFile(join(dir, "future.md"), doc(`status: blocked\nwake: ${FUTURE}`, "# Future"));
		await writeFile(join(dir, "ready.md"), doc("status: in-progress", "# Ready"));
		await writeFile(join(dir, "done.md"), doc("status: done", "# Done"));
		const entries = await readActiveTasks(dir, NOW);
		expect(entries.map((entry) => entry.id)).toEqual(["ready", "done", "future"]);
		// done sorts before the future-wake task because done has no wake ("ready now" slot),
		// but it is not actionable.
		expect(entries.find((entry) => entry.id === "done")?.actionable).toBe(false);
		expect(entries.find((entry) => entry.id === "ready")?.actionable).toBe(true);
	});

	it("is fail-open on unreadable frontmatter", async () => {
		await writeFile(join(dir, "broken.md"), "no frontmatter at all");
		const entry = (await readActiveTasks(dir, NOW))[0];
		expect(entry.frontmatter.readable).toBe(false);
		expect(entry.actionable).toBe(true);
	});

	it("reports the last Current Cycle entry as the latest note", async () => {
		await writeFile(
			join(dir, "progress.md"),
			doc("status: in-progress", "# Progress\n\n## Current Cycle\n- first\n- second\n\n## History\n- old"),
		);
		const entry = (await readActiveTasks(dir, NOW))[0];
		expect(entry.latestNote).toBe("second");
	});
});
