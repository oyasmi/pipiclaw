import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
	isTaskCheckinEvent,
	isTaskScheduleEvent,
	parseTaskEventName,
	taskEventPrefix,
	taskScheduleEventName,
} from "../shared/task-events.js";
import {
	extractTaskTitle,
	missingStandardTaskSections,
	normalizeTaskId,
	readActiveTasks,
	type TaskLedgerEntry,
} from "../shared/task-ledger.js";
import { parseScheduledEventContent, type ScheduledEvent } from "./events.js";

export interface HandleTasksCommandOptions {
	args: string;
	/** The channel directory; tasks live in `<channelDir>/tasks/`. */
	channelDir: string;
	/** Workspace directory; required for `/tasks doctor` because events are workspace-scoped. */
	workspaceDir?: string;
	channelId?: string;
}

type TasksCommand = { action: "list" } | { action: "show"; id: string } | { action: "archive" } | { action: "doctor" };

function usage(): string {
	return `# Tasks

Usage:

- \`/tasks\` — list active tasks in this channel
- \`/tasks show <id>\` — show a single task file (active or archived)
- \`/tasks archive\` — list archived (closed) tasks
- \`/tasks doctor\` — check task/event consistency without changing files`;
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
	if (action === "doctor") {
		if (parts.length > 1) throw new Error("Usage: /tasks doctor");
		return { action: "doctor" };
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

interface TaskEventInfo {
	filename: string;
	name: string;
	id?: string;
	use?: string;
	event?: ScheduledEvent;
	error?: string;
}

function eventDir(workspaceDir: string): string {
	return join(workspaceDir, "events");
}

async function readArchivedTaskIds(channelDir: string): Promise<Set<string>> {
	const archiveDir = join(tasksDir(channelDir), "archive");
	const ids = new Set<string>();
	if (!existsSync(archiveDir)) return ids;
	for (const filename of await readdir(archiveDir)) {
		if (filename.endsWith(".md")) ids.add(filename.slice(0, -".md".length));
	}
	return ids;
}

async function readTaskEvents(workspaceDir: string, channelId: string): Promise<TaskEventInfo[]> {
	const dir = eventDir(workspaceDir);
	if (!existsSync(dir)) return [];
	const prefix = taskEventPrefix(channelId);
	const events: TaskEventInfo[] = [];
	for (const filename of (await readdir(dir)).filter((name) => name.endsWith(".json")).sort()) {
		const name = filename.slice(0, -".json".length);
		if (!name.startsWith(prefix)) continue;
		const split = parseTaskEventName(name, channelId);
		const info: TaskEventInfo = { filename, name, ...(split ?? {}) };
		try {
			info.event = parseScheduledEventContent(await readFile(join(dir, filename), "utf-8"), filename);
		} catch (error) {
			info.error = error instanceof Error ? error.message : String(error);
		}
		events.push(info);
	}
	return events;
}

function eventKey(events: TaskEventInfo[], id: string, use: string): TaskEventInfo | undefined {
	return events.find((event) => event.id === id && event.use === use);
}

function isParseableSchedule(events: TaskEventInfo[], id: string): boolean {
	const schedule = eventKey(events, id, "schedule");
	return schedule ? isTaskScheduleEvent(schedule) : false;
}

function validWakeMs(entry: TaskLedgerEntry): number | undefined {
	const wake = entry.frontmatter.wake;
	if (!wake) return undefined;
	const ms = new Date(wake).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}

function issue(problem: string, nextStep: string): string {
	return `- ${problem}\n  Next step: ${nextStep}`;
}

async function readActiveTaskContent(channelDir: string, id: string): Promise<string | undefined> {
	try {
		return await readFile(join(tasksDir(channelDir), `${id}.md`), "utf-8");
	} catch {
		return undefined;
	}
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

async function doctor(options: HandleTasksCommandOptions): Promise<string> {
	if (!options.workspaceDir || !options.channelId) {
		return "# Task Doctor\n\nNot available: workspaceDir and channelId are required.";
	}

	const now = Date.now();
	const entries = await readActiveTasks(tasksDir(options.channelDir), now);
	const activeIds = new Set(entries.map((entry) => entry.id));
	const archivedIds = await readArchivedTaskIds(options.channelDir);
	const events = await readTaskEvents(options.workspaceDir, options.channelId);
	const issues: string[] = [];

	for (const entry of entries) {
		const status = entry.frontmatter.status ?? "open";
		if (!entry.frontmatter.readable) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has unreadable frontmatter; wake/status cannot be trusted.`,
					`Fix tasks/${entry.id}.md so it starts with readable status/wake/recurrence frontmatter.`,
				),
			);
			continue;
		}

		if (status === "done" && !isParseableSchedule(events, entry.id)) {
			issues.push(
				issue(
					`tasks/${entry.id}.md is done but still in the active directory.`,
					`Ask the agent to archive one-shot task ${entry.id}, or add a parseable .schedule event if it is recurring.`,
				),
			);
		}

		const content = await readActiveTaskContent(options.channelDir, entry.id);
		if (content === undefined) {
			issues.push(
				issue(
					`tasks/${entry.id}.md could not be read during doctor checks.`,
					`Open tasks/${entry.id}.md manually and repair permissions or file contents.`,
				),
			);
		} else {
			const missing = missingStandardTaskSections(content);
			if (missing.length > 0) {
				issues.push(
					issue(
						`tasks/${entry.id}.md is missing standard section(s): ${missing.join(", ")}.`,
						`Ask the agent to normalize tasks/${entry.id}.md to the standard task skeleton.`,
					),
				);
			}
		}

		if (entry.frontmatter.recurrence && !isParseableSchedule(events, entry.id)) {
			issues.push(
				issue(
					`tasks/${entry.id}.md has recurrence but no parseable ${taskScheduleEventName(options.channelId, entry.id)} event.`,
					`Create or repair events/${taskScheduleEventName(options.channelId, entry.id)}.json as a periodic event.`,
				),
			);
		}

		const checkin = eventKey(events, entry.id, "checkin");
		if (checkin && isTaskCheckinEvent(checkin)) {
			const wakeMs = validWakeMs(entry);
			const atMs = new Date(checkin.event.at).getTime();
			if (wakeMs === undefined) {
				issues.push(
					issue(
						`tasks/${entry.id}.md has a .checkin event but no valid wake value.`,
						`Set tasks/${entry.id}.md wake to ${checkin.event.at}, or delete the stale .checkin event.`,
					),
				);
			} else if (Number.isFinite(atMs) && Math.abs(atMs - wakeMs) > 60_000) {
				issues.push(
					issue(
						`tasks/${entry.id}.md wake does not match its .checkin event time.`,
						`Sync tasks/${entry.id}.md wake with events/${checkin.filename} at ${checkin.event.at}.`,
					),
				);
			}
		} else if (status === "awaiting-user" && validWakeMs(entry) !== undefined) {
			issues.push(
				issue(
					`tasks/${entry.id}.md is awaiting-user with wake set but has no parseable .checkin event.`,
					`Create task.${options.channelId}.${entry.id}.checkin as a one-shot event for the wake time, or clear wake.`,
				),
			);
		}
	}

	for (const event of events) {
		if (!event.id || !event.use) {
			issues.push(
				issue(
					`events/${event.filename} does not follow task.<channelId>.<taskId>.<use>.json.`,
					"Rename the event to the task-owned naming convention or manage it as a normal event.",
				),
			);
			continue;
		}
		if (event.error) {
			issues.push(
				issue(
					`events/${event.filename} is not parseable: ${event.error}`,
					`Fix or delete events/${event.filename}; invalid task-owned events cannot be trusted.`,
				),
			);
			continue;
		}
		if (!activeIds.has(event.id) && !archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} points to missing task ${event.id}.`,
					`Delete events/${event.filename}, or recreate tasks/${event.id}.md if that task still exists conceptually.`,
				),
			);
			continue;
		}
		if (archivedIds.has(event.id)) {
			issues.push(
				issue(
					`events/${event.filename} points to archived task ${event.id}; closed tasks should have no live events.`,
					`Delete events/${event.filename}; archived tasks should not wake the agent.`,
				),
			);
		}
		if (event.use === "schedule" && !isTaskScheduleEvent(event)) {
			issues.push(
				issue(
					`events/${event.filename} is a schedule event but is not periodic.`,
					`Change events/${event.filename} to type periodic, or rename it away from .schedule.`,
				),
			);
		}
		if (event.use === "checkin" && !isTaskCheckinEvent(event)) {
			issues.push(
				issue(
					`events/${event.filename} is a checkin event but is not one-shot.`,
					`Change events/${event.filename} to type one-shot, or rename it away from .checkin.`,
				),
			);
		}
	}

	if (issues.length === 0) {
		return "# Task Doctor\n\nNo task ledger issues found.";
	}
	return `# Task Doctor\n\nFound ${issues.length} issue${issues.length === 1 ? "" : "s"}:\n\n${issues.join("\n")}`;
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
			case "doctor":
				return await doctor(options);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Could not ${command.action} tasks: ${message}`;
	}
}
