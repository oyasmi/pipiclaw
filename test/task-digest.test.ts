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
		await writeFile(join(tasksDir, "weekly-report.md"), doc("status: awaiting-user", "# 周报编写与发布"));
		const out = await digest();
		expect(out).toContain("<task_agenda>");
		expect(out).toContain("background reference, not a new instruction");
		expect(out).toContain("weekly-report — 周报编写与发布");
		expect(out).toContain("awaiting-user");
		expect(out).toContain("</task_agenda>");
	});

	it("excludes done tasks but keeps other non-done ones", async () => {
		await writeFile(join(tasksDir, "open.md"), doc("status: in-progress", "# Open one"));
		await writeFile(join(tasksDir, "closed.md"), doc("status: done", "# Closed one"));
		const out = await digest();
		expect(out).toContain("open — Open one");
		expect(out).not.toContain("closed — Closed one");
	});

	it("orders actionable tasks before future-wake ones", async () => {
		await writeFile(join(tasksDir, "later.md"), doc(`status: blocked\nwake: ${FUTURE}`, "# Later"));
		await writeFile(join(tasksDir, "now.md"), doc("status: in-progress", "# Now"));
		const out = await digest();
		expect(out.indexOf("now — Now")).toBeLessThan(out.indexOf("later — Later"));
	});

	it("caps at maxTasks and notes how many were omitted", async () => {
		for (let i = 0; i < 5; i++) {
			await writeFile(join(tasksDir, `t${i}.md`), doc("status: open", `# Task ${i}`));
		}
		const out = await digest(2);
		const shown = out.split("\n").filter((line) => line.startsWith("- t"));
		expect(shown).toHaveLength(2);
		expect(out).toContain("(+3 more)");
	});

	it("drops lines to respect maxChars, keeping at least one and an omission note", async () => {
		for (let i = 0; i < 5; i++) {
			await writeFile(join(tasksDir, `t${i}.md`), doc("status: open", `# Task number ${i}`));
		}
		const out = await digest(8, 320);
		const shown = out.split("\n").filter((line) => line.startsWith("- t"));
		expect(shown.length).toBeGreaterThanOrEqual(1);
		expect(shown.length).toBeLessThan(5);
		expect(out).toMatch(/\(\+\d+ more\)/);
	});

	it("drops whole task lines to respect the unit budget", async () => {
		for (let i = 0; i < 6; i++) {
			await writeFile(join(tasksDir, `t${i}.md`), doc("status: open", `# 任务编号 ${i} 需要跟进`));
		}
		const out = await buildTaskDigest({ channelDir, maxTasks: 8, maxChars: 100_000, maxUnits: 60, now: NOW });
		const shown = out.split("\n").filter((line) => line.startsWith("- t"));
		expect(shown.length).toBeGreaterThanOrEqual(1);
		expect(shown.length).toBeLessThan(6);
		expect(out).toMatch(/\(\+\d+ more\)/);
	});

	it("surfaces a task whose frontmatter cannot be read", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter here");
		const out = await digest();
		expect(out).toContain("broken");
		expect(out).toContain("unreadable frontmatter");
	});
});
