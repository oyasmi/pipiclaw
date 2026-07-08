import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractTaskTitle,
	isTaskActionable,
	normalizeTaskId,
	parseTaskFrontmatter,
	readActiveTasks,
	taskBody,
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
});
