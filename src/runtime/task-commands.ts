import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { extractTaskTitle, normalizeTaskId, readActiveTasks } from "../shared/task-ledger.js";

export interface HandleTasksCommandOptions {
	args: string;
	/** The channel directory; tasks live in `<channelDir>/tasks/`. */
	channelDir: string;
}

type TasksCommand = { action: "list" } | { action: "show"; id: string } | { action: "archive" };

function usage(): string {
	return `# Tasks

Usage:

- \`/tasks\` — list active tasks in this channel
- \`/tasks show <id>\` — show a single task file (active or archived)
- \`/tasks archive\` — list archived (closed) tasks`;
}

function parseTasksCommand(args: string): TasksCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0];

	if (!action || action === "list") {
		if (parts.length > 1) throw new Error("Usage: /tasks list");
		return { action: "list" };
	}
	if (action === "show") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error("Usage: /tasks show <id>");
		return { action: "show", id };
	}
	if (action === "archive") {
		if (parts.length > 1) throw new Error("Usage: /tasks archive");
		return { action: "archive" };
	}
	throw new Error(`Unknown /tasks action: ${action}`);
}

function tasksDir(channelDir: string): string {
	return join(channelDir, "tasks");
}

/** Resolve `<tasksDir>/[archive/]<id>.md`, rejecting any path that escapes the tasks dir. */
function resolveTaskPath(dir: string, id: string, subdir?: string): string {
	const base = resolve(dir);
	const target = resolve(base, subdir ?? "", `${id}.md`);
	const expected = subdir ? join(base, subdir, `${id}.md`) : join(base, `${id}.md`);
	if (target !== expected || !target.startsWith(`${base}${sep}`)) {
		throw new Error(`Invalid task id: ${id}`);
	}
	return target;
}

function relativeWake(wakeMs: number | undefined, now: number): string {
	if (wakeMs === undefined) return "—";
	const iso = new Date(wakeMs).toISOString();
	const diffMs = wakeMs - now;
	if (diffMs <= 0) return `${iso} (due)`;
	const minutes = Math.round(diffMs / 60000);
	const rel =
		minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
	return `${iso} (${rel})`;
}

async function listTasks(channelDir: string): Promise<string> {
	const dir = tasksDir(channelDir);
	const now = Date.now();
	const entries = await readActiveTasks(dir, now);
	if (entries.length === 0) {
		return "# Tasks\n\nNo active tasks.";
	}

	const blocks = entries.map((entry) => {
		const status = entry.frontmatter.readable ? (entry.frontmatter.status ?? "open") : "⚠ unreadable frontmatter";
		const detail = [`  status: ${status}`, `wake: ${relativeWake(entry.wakeMs, now)}`];
		if (entry.frontmatter.recurrence) detail.push(`recurrence: ${entry.frontmatter.recurrence}`);
		return `- ${entry.id} — ${entry.title}\n${detail.join("   ")}`;
	});
	return `# Tasks: ${entries.length} active\n\n${blocks.join("\n")}`;
}

async function showTask(channelDir: string, id: string): Promise<string> {
	const dir = tasksDir(channelDir);
	const taskId = normalizeTaskId(id);
	const activePath = resolveTaskPath(dir, taskId);
	const archivePath = resolveTaskPath(dir, taskId, "archive");

	const path = existsSync(activePath) ? activePath : existsSync(archivePath) ? archivePath : undefined;
	if (!path) {
		return `Task not found: ${taskId}`;
	}
	const location = path === archivePath ? " (archived)" : "";
	const content = await readFile(path, "utf-8");
	return `# Task: ${taskId}${location}\n\n\`\`\`markdown\n${content}\n\`\`\``;
}

async function listArchive(channelDir: string): Promise<string> {
	const dir = join(tasksDir(channelDir), "archive");
	if (!existsSync(dir)) {
		return "# Archived Tasks\n\nNo archived tasks.";
	}
	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".md")).sort();
	if (filenames.length === 0) {
		return "# Archived Tasks\n\nNo archived tasks.";
	}
	const blocks: string[] = [];
	for (const filename of filenames) {
		const id = filename.slice(0, -".md".length);
		try {
			const content = await readFile(join(dir, filename), "utf-8");
			blocks.push(`- ${id} — ${extractTaskTitle(content, id)}`);
		} catch {
			blocks.push(`- ${id}`);
		}
	}
	return `# Archived Tasks: ${blocks.length}\n\n${blocks.join("\n")}`;
}

export async function handleTasksCommand(options: HandleTasksCommandOptions): Promise<string> {
	let command: TasksCommand;
	try {
		command = parseTasksCommand(options.args);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `${message}\n\n${usage()}`;
	}

	try {
		switch (command.action) {
			case "list":
				return await listTasks(options.channelDir);
			case "show":
				return await showTask(options.channelDir, command.id);
			case "archive":
				return await listArchive(options.channelDir);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Could not ${command.action} tasks: ${message}`;
	}
}
