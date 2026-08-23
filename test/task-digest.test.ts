import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskDigest } from "../src/memory/task-digest.js";

const NOW = Date.parse("2026-07-08T12:00:00+08:00");
const FUTURE = "2026-07-08T18:00:00+08:00";

function doc(front: string, body: string): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("buildTaskDigest", () => {
	let channelDir: string;
	let tasksDir: string;
	beforeEach(async () => {
		channelDir = await mkdtemp(join(tmpdir(), "task-digest-"));
		tasksDir = join(channelDir, "tasks");
		await mkdir(tasksDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(channelDir, { recursive: true, force: true });
	});

	async function digest(maxTasks = 8, maxChars = 1000): Promise<string> {
		return buildTaskDigest({ channelDir, maxTasks, maxChars, now: NOW });
	}

	it("returns empty when there are no active tasks", async () => {
		expect(await digest()).toBe("");
	});

	it("includes non-done tasks with the background-reference framing", async () => {
		await writeFile(join(tasksDir, "weekly-report.md"), doc("status: waiting", "# 周报编写与发布"));
		const out = await digest();
		expect(out).toContain("<task_agenda>");
		expect(out).toContain("background reference, not a new instruction");
		expect(out).toContain("weekly-report — 周报编写与发布");
		expect(out).toContain("waiting");
		expect(out).toContain("</task_agenda>");
	});

	// spec 037, D4: the agenda line shows Plan progress and the current step.
	it("includes plan progress and the current step when the task has a Plan", async () => {
		await writeFile(
			join(tasksDir, "planned.md"),
			doc("status: active", "# Planned\n\n## Plan\n- [x] P1 step one\n- [ ] P2 step two\n"),
		);
		const out = await digest();
		expect(out).toContain("plan 1/2 · @P2");
	});

	it("excludes done tasks but keeps other non-done ones", async () => {
		await writeFile(join(tasksDir, "open.md"), doc("status: active", "# Open one"));
		await writeFile(join(tasksDir, "closed.md"), doc("outcome: completed", "# Closed one"));
		const out = await digest();
		expect(out).toContain("open — Open one");
		expect(out).not.toContain("closed — Closed one");
	});

	it("orders actionable tasks before future-wake ones", async () => {
		await writeFile(join(tasksDir, "later.md"), doc(`status: waiting\nwake: ${FUTURE}`, "# Later"));
		await writeFile(join(tasksDir, "now.md"), doc("status: active", "# Now"));
		const out = await digest();
		expect(out.indexOf("now — Now")).toBeLessThan(out.indexOf("later — Later"));
	});

	it.each([
		{
			dimension: "maxTasks",
			config: { maxTasks: 2, maxChars: 1000 },
			taskCount: 5,
			taskTitle: (i: number) => `# Task ${i}`,
			exactShown: 2,
		},
		{
			dimension: "maxChars",
			config: { maxTasks: 8, maxChars: 320 },
			taskCount: 5,
			taskTitle: (i: number) => `# Task number ${i}`,
		},
		{
			dimension: "maxUnits (whole-task, not char, budget)",
			config: { maxTasks: 8, maxChars: 100_000, maxUnits: 60 },
			taskCount: 6,
			taskTitle: (i: number) => `# 任务编号 ${i} 需要跟进`,
		},
	])("drops lines to respect the $dimension budget", async ({ config, taskCount, taskTitle, exactShown }) => {
		for (let i = 0; i < taskCount; i++) {
			await writeFile(join(tasksDir, `t${i}.md`), doc("status: active", taskTitle(i)));
		}
		const out = await buildTaskDigest({ channelDir, now: NOW, ...config });
		const shown = out.split("\n").filter((line) => line.startsWith("- t"));
		if (exactShown !== undefined) {
			expect(shown).toHaveLength(exactShown);
		} else {
			expect(shown.length).toBeGreaterThanOrEqual(1);
			expect(shown.length).toBeLessThan(taskCount);
		}
		expect(out).toMatch(/\(\+\d+ more\)/);
	});

	it("surfaces a task whose frontmatter cannot be read", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter here");
		const out = await digest();
		expect(out).toContain("broken");
		expect(out).toContain("unreadable frontmatter");
	});
});
