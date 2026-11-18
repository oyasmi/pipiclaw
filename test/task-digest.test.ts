import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTaskDigest } from "../src/agent/turn/task-digest.js";
import { countPromptUnits } from "../src/shared/prompt-units.js";

const SINCE = "2026-07-08T12:00:00+08:00";
const ASKING = `state: waiting\nwaiting: {"kind":"user","question":"要合并到主分支吗？","since":"${SINCE}"}`;

function doc(front: string, body: string): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("buildTaskDigest", () => {
	let deskDir: string;
	let tasksDir: string;
	beforeEach(async () => {
		deskDir = await mkdtemp(join(tmpdir(), "task-digest-"));
		tasksDir = join(deskDir, "tasks");
		await mkdir(tasksDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(deskDir, { recursive: true, force: true });
	});

	async function digest(maxTasks = 8, maxChars = 1000): Promise<string> {
		return buildTaskDigest({ deskDir, maxTasks, maxChars });
	}

	it("prioritizes this channel's open question and keeps other delivery addresses as pointers", async () => {
		expect(await digest()).toBe("");

		const channelId = "dingtalk:dm:current";
		const otherChannel = "dingtalk:dm:other";
		await writeFile(join(tasksDir, "weekly-report.md"), doc(`${ASKING}\nchannel: ${channelId}`, "# 周报编写与发布"));
		await writeFile(join(tasksDir, "other.md"), doc(`${ASKING}\nchannel: ${otherChannel}`, "# Other room"));
		await writeFile(join(tasksDir, "running.md"), doc(`state: running\nchannel: ${channelId}`, "# In progress"));
		await writeFile(join(tasksDir, "closed.md"), doc("outcome: completed", "# Closed one"));
		const out = await buildTaskDigest({ deskDir, channelId, maxTasks: 1, maxChars: 1000 });
		expect(out).toContain("<task_agenda>");
		expect(out).toContain("weekly-report — 周报编写与发布");
		// The question the task waits on is in the agenda, so chat can pass the user's answer along.
		expect(out).toContain("要合并到主分支吗？");
		expect(out).toContain("</task_agenda>");
		expect(out).toContain("(+2 more)");
		const all = await buildTaskDigest({ deskDir, channelId, maxTasks: 8, maxChars: 1000 });
		expect(all).toContain(otherChannel);
		expect(all).not.toContain("Other room");
		expect(all.match(/要合并到主分支吗？/g)).toHaveLength(1);
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
			await writeFile(join(tasksDir, `t${i}.md`), doc("state: queued", taskTitle(i)));
		}
		const out = await buildTaskDigest({ deskDir, ...config });
		expect(out.length).toBeLessThanOrEqual(config.maxChars);
		if ("maxUnits" in config) expect(countPromptUnits(out)).toBeLessThanOrEqual(config.maxUnits!);
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
