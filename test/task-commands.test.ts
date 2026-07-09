import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleTasksCommand } from "../src/runtime/task-commands.js";
import { renderStandardTaskBody } from "../src/shared/task-ledger.js";

const FUTURE = "2026-07-08T23:59:00+08:00";

function doc(front: string, body: string): string {
	return `---\n${front}\n---\n\n${body}`;
}

const STANDARD_BODY = renderStandardTaskBody({
	title: "Active",
	goal: "Do the work.",
	dod: "- [ ] Done",
	manual: "Work carefully.",
});

describe("handleTasksCommand", () => {
	const channelId = "dm_1";
	let workspaceDir: string;
	let channelDir: string;
	let tasksDir: string;
	let eventsDir: string;
	beforeEach(async () => {
		workspaceDir = await mkdtemp(join(tmpdir(), "task-cmd-"));
		channelDir = join(workspaceDir, channelId);
		tasksDir = join(channelDir, "tasks");
		eventsDir = join(workspaceDir, "events");
		await mkdir(tasksDir, { recursive: true });
		await mkdir(eventsDir, { recursive: true });
	});
	afterEach(async () => {
		await rm(workspaceDir, { recursive: true, force: true });
	});

	function run(args: string): Promise<string> {
		return handleTasksCommand({ args, channelDir, workspaceDir, channelId });
	}

	async function writeEvent(name: string, event: object | string): Promise<void> {
		await writeFile(join(eventsDir, `${name}.json`), typeof event === "string" ? event : JSON.stringify(event));
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

	it("reports no doctor issues for a clean ledger", async () => {
		await writeFile(join(tasksDir, "active.md"), doc("status: open", STANDARD_BODY));
		expect(await run("doctor")).toContain("No task ledger issues found");
	});

	it("doctor reports non-standard task skeletons", async () => {
		await writeFile(join(tasksDir, "thin.md"), doc("status: open", "# Thin task"));
		const out = await run("doctor");
		expect(out).toContain("missing standard section");
		expect(out).toContain("normalize tasks/thin.md");
	});

	it("doctor reports task/event consistency issues", async () => {
		await writeFile(
			join(tasksDir, "weekly.md"),
			doc(`status: awaiting-user\nwake: ${FUTURE}\nrecurrence: 每周一`, "# Weekly"),
		);
		await writeEvent("task.dm_1.weekly.checkin", {
			type: "one-shot",
			channelId,
			text: "回访",
			at: "2026-07-08T20:00:00+08:00",
		});

		const archiveDir = join(tasksDir, "archive");
		await mkdir(archiveDir, { recursive: true });
		await writeFile(join(archiveDir, "old.md"), doc("status: done", "# Old"));
		await writeEvent("task.dm_1.old.checkin", {
			type: "one-shot",
			channelId,
			text: "old",
			at: "2026-07-08T20:00:00+08:00",
		});
		await writeEvent("task.dm_1.ghost.checkin", {
			type: "one-shot",
			channelId,
			text: "ghost",
			at: "2026-07-08T20:00:00+08:00",
		});

		const out = await run("doctor");
		expect(out).toContain("has recurrence but no parseable");
		expect(out).toContain("wake does not match");
		expect(out).toContain("points to archived task old");
		expect(out).toContain("points to missing task ghost");
		expect(out).toContain("Next step:");
	});
});
