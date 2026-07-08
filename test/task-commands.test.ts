import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleTasksCommand } from "../src/runtime/task-commands.js";

const FUTURE = "2026-07-08T23:59:00+08:00";

function doc(front: string, body: string): string {
	return `---\n${front}\n---\n\n${body}`;
}

describe("handleTasksCommand", () => {
	let channelDir: string;
	let tasksDir: string;
	beforeEach(async () => {
		channelDir = await mkdtemp(join(tmpdir(), "task-cmd-"));
		tasksDir = join(channelDir, "tasks");
		await mkdir(tasksDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(channelDir, { recursive: true, force: true });
	});

	function run(args: string): Promise<string> {
		return handleTasksCommand({ args, channelDir });
	}

	it("reports no active tasks for an empty ledger", async () => {
		expect(await run("")).toContain("No active tasks");
	});

	it("lists active tasks actionable-first", async () => {
		await writeFile(join(tasksDir, "later.md"), doc(`status: blocked\nwake: ${FUTURE}`, "# Later task"));
		await writeFile(join(tasksDir, "now.md"), doc("status: in-progress", "# Now task"));
		const out = await run("");
		expect(out).toContain("2 active");
		expect(out.indexOf("now — Now task")).toBeLessThan(out.indexOf("later — Later task"));
	});

	it("marks a task with unreadable frontmatter", async () => {
		await writeFile(join(tasksDir, "broken.md"), "no frontmatter");
		expect(await run("")).toContain("⚠ unreadable frontmatter");
	});

	it("shows a single active task's full content", async () => {
		await writeFile(join(tasksDir, "weekly.md"), doc("status: open", "# 周报\n\nbody here"));
		const out = await run("show weekly");
		expect(out).toContain("# Task: weekly");
		expect(out).toContain("body here");
	});

	it("shows an archived task", async () => {
		const archiveDir = join(tasksDir, "archive");
		await mkdir(archiveDir, { recursive: true });
		await writeFile(join(archiveDir, "old.md"), doc("status: done", "# Old"));
		const out = await run("show old");
		expect(out).toContain("(archived)");
		expect(out).toContain("# Old");
	});

	it("reports a missing task", async () => {
		expect(await run("show ghost")).toContain("Task not found: ghost");
	});

	it("rejects a traversal id", async () => {
		expect(await run("show ../../secret")).toMatch(/Invalid task id/);
	});

	it("lists archived tasks", async () => {
		const archiveDir = join(tasksDir, "archive");
		await mkdir(archiveDir, { recursive: true });
		await writeFile(join(archiveDir, "fix-login.md"), doc("status: done", "# Fix login bug"));
		const out = await run("archive");
		expect(out).toContain("fix-login — Fix login bug");
	});

	it("shows usage for an unknown action", async () => {
		expect(await run("frobnicate")).toContain("Usage:");
	});
});
