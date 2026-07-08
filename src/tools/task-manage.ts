import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { parseScheduledEventContent } from "../runtime/events.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { normalizeTaskId, parseTaskFrontmatter, readActiveTasks, taskBody } from "../shared/task-ledger.js";

const SETTABLE_STATUSES = ["open", "in-progress", "awaiting-user", "blocked"] as const;

const taskManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the ledger change (shown to the user)" }),
	action: Type.Union([Type.Literal("set"), Type.Literal("done"), Type.Literal("list")], {
		description:
			'"set" updates a task\'s status/wake/recurrence; "done" closes it out (archive one-shot tasks, clean up residual events); "list" returns active tasks.',
	}),
	id: Type.Optional(Type.String({ description: "Task id (filename without .md). Required for set/done." })),
	status: Type.Optional(
		Type.Union(
			SETTABLE_STATUSES.map((status) => Type.Literal(status)),
			{ description: "New status for set. To close a task use action done, not status." },
		),
	),
	wake: Type.Optional(
		Type.String({
			description:
				"ISO8601 earliest-recheck time for set; empty string clears it. Keep in sync with any .checkin event.",
		}),
	),
	recurrence: Type.Optional(Type.String({ description: "Annotation only (e.g. 每周一); empty string clears it." })),
});

export type TaskManageAction = "set" | "done" | "list";

export interface TaskManageResult {
	action: TaskManageAction;
	id?: string;
	path?: string;
	status?: string;
	archived?: boolean;
	deletedEvents?: string[];
	tasks?: Array<{ id: string; title: string; status: string; wake?: string; actionable: boolean }>;
	notice: string;
}

export interface TaskManageRequest {
	action: TaskManageAction;
	id?: string;
	status?: string;
	wake?: string;
	recurrence?: string;
}

export interface TaskManageToolOptions {
	workspaceDir: string;
	workspacePath: string;
	channelDir: string;
	channelId: string;
}

interface TaskFields {
	status: string;
	wake?: string;
	recurrence?: string;
}

function parseAction(action: string): TaskManageAction {
	if (action === "set" || action === "done" || action === "list") {
		return action;
	}
	throw new Error('Unsupported task action. Use "set", "done", or "list".');
}

function toWorkspacePath(options: TaskManageToolOptions, hostPath: string): string {
	if (hostPath.startsWith(options.workspaceDir)) {
		return `${options.workspacePath}${hostPath.slice(options.workspaceDir.length)}`;
	}
	return hostPath;
}

function tasksDir(options: TaskManageToolOptions): string {
	return join(options.channelDir, "tasks");
}

function eventsDir(options: TaskManageToolOptions): string {
	return join(options.workspaceDir, "events");
}

function renderTaskFile(fields: TaskFields, body: string): string {
	const lines = ["---", `status: ${fields.status}`];
	if (fields.wake) lines.push(`wake: ${fields.wake}`);
	if (fields.recurrence) lines.push(`recurrence: ${fields.recurrence}`);
	lines.push("---");
	return `${lines.join("\n")}\n${body}`;
}

/**
 * Read a task file and split it into its three-field frontmatter and verbatim body.
 * Fail-closed: an unreadable frontmatter block is rejected (fix it with edit first)
 * rather than guessed at, so task_manage never silently mangles a body.
 */
async function readTaskDocument(taskPath: string, id: string): Promise<{ fields: TaskFields; body: string }> {
	if (!existsSync(taskPath)) {
		throw new Error(`Task "${id}" does not exist; create it with write first.`);
	}
	const content = await readFile(taskPath, "utf-8");
	const frontmatter = parseTaskFrontmatter(content);
	if (!frontmatter.readable) {
		throw new Error(`Task "${id}" has no readable frontmatter; fix it with edit before using task_manage.`);
	}
	return {
		fields: {
			status: frontmatter.status ?? "open",
			wake: frontmatter.wake,
			recurrence: frontmatter.recurrence,
		},
		body: taskBody(content),
	};
}

/** Apply a `set` request's optional fields onto the existing frontmatter. */
function applySet(fields: TaskFields, request: TaskManageRequest): TaskFields {
	const next: TaskFields = { ...fields };
	if (request.status !== undefined) {
		if (!(SETTABLE_STATUSES as readonly string[]).includes(request.status)) {
			throw new Error(
				`Invalid status "${request.status}". Use one of ${SETTABLE_STATUSES.join(", ")}, or action "done".`,
			);
		}
		next.status = request.status;
	}
	if (request.wake !== undefined) {
		const trimmed = request.wake.trim();
		if (trimmed === "") {
			next.wake = undefined;
		} else if (!Number.isFinite(new Date(trimmed).getTime())) {
			throw new Error(`wake "${request.wake}" is not a valid ISO8601 date.`);
		} else {
			next.wake = trimmed;
		}
	}
	if (request.recurrence !== undefined) {
		const trimmed = request.recurrence.trim();
		next.recurrence = trimmed === "" ? undefined : trimmed;
	}
	return next;
}

/**
 * On close-out, delete residual one-shot/immediate events named `task.<channelId>.<id>.*`
 * and report whether a periodic (schedule) event survives. Unparseable events with the
 * prefix are left untouched (fail-safe: don't blind-delete something we can't classify).
 */
async function cleanupTaskEvents(
	options: TaskManageToolOptions,
	id: string,
): Promise<{ deleted: string[]; hasPeriodic: boolean }> {
	const dir = eventsDir(options);
	if (!existsSync(dir)) return { deleted: [], hasPeriodic: false };

	const prefix = `task.${options.channelId}.${id}.`;
	const deleted: string[] = [];
	let hasPeriodic = false;

	for (const filename of await readdir(dir)) {
		if (!filename.endsWith(".json") || !filename.startsWith(prefix)) continue;
		const eventPath = join(dir, filename);
		let type: string | undefined;
		try {
			type = parseScheduledEventContent(await readFile(eventPath, "utf-8"), filename).type;
		} catch {
			continue; // can't classify → leave it for /events to handle
		}
		if (type === "periodic") {
			hasPeriodic = true; // the cadence lives on for the next cycle
			continue;
		}
		await unlink(eventPath);
		deleted.push(filename.slice(0, -".json".length));
	}
	return { deleted, hasPeriodic };
}

async function setTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "set" requires an id.');
	const id = normalizeTaskId(request.id);
	const taskPath = join(tasksDir(options), `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);
	const nextFields = applySet(fields, request);
	await writeFileAtomically(taskPath, renderTaskFile(nextFields, body));
	return {
		action: "set",
		id,
		path: toWorkspacePath(options, taskPath),
		status: nextFields.status,
		notice: `已更新任务 \`${id}\`（status: ${nextFields.status}${nextFields.wake ? `, wake: ${nextFields.wake}` : ""}）。`,
	};
}

async function doneTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "done" requires an id.');
	const id = normalizeTaskId(request.id);
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const { fields, body } = await readTaskDocument(taskPath, id);

	await writeFileAtomically(taskPath, renderTaskFile({ ...fields, status: "done" }, body));
	const { deleted, hasPeriodic } = await cleanupTaskEvents(options, id);

	// Periodic task → sleeps in place until its schedule fires next; one-shot → archive.
	let archived = false;
	let finalPath = taskPath;
	if (!hasPeriodic) {
		const archiveDir = join(dir, "archive");
		await mkdir(archiveDir, { recursive: true });
		finalPath = join(archiveDir, `${id}.md`);
		await rename(taskPath, finalPath);
		archived = true;
	}

	const cleanup = deleted.length > 0 ? `，清理事件 ${deleted.join(", ")}` : "";
	const disposition = archived ? "已归档" : "周期任务留原地待下次唤醒";
	return {
		action: "done",
		id,
		path: toWorkspacePath(options, finalPath),
		status: "done",
		archived,
		deletedEvents: deleted,
		notice: `任务 \`${id}\` 已完成（${disposition}${cleanup}）。`,
	};
}

async function listTasks(options: TaskManageToolOptions): Promise<TaskManageResult> {
	const entries = await readActiveTasks(tasksDir(options));
	return {
		action: "list",
		tasks: entries.map((entry) => ({
			id: entry.id,
			title: entry.title,
			status: entry.frontmatter.readable ? (entry.frontmatter.status ?? "open") : "unreadable",
			wake: entry.frontmatter.wake,
			actionable: entry.actionable,
		})),
		notice: `台账共有 ${entries.length} 个 active 任务。`,
	};
}

export async function manageTask(
	options: TaskManageToolOptions,
	request: TaskManageRequest,
): Promise<TaskManageResult> {
	switch (request.action) {
		case "set":
			return setTask(options, request);
		case "done":
			return doneTask(options, request);
		case "list":
			return listTasks(options);
	}
}

export function createTaskManageTool(options: TaskManageToolOptions): AgentTool<typeof taskManageSchema> {
	return {
		name: "task_manage",
		label: "task_manage",
		description:
			"Manage this channel's task ledger frontmatter and lifecycle: set status/wake/recurrence, close a task out " +
			"(archiving one-shot tasks and cleaning up its residual events), or list active tasks. Write the task body " +
			"(goal, DoD, manual, cycle log) with write/edit; this tool owns only the frontmatter and close-out.",
		parameters: taskManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				label: string;
				action: string;
				id?: string;
				status?: string;
				wake?: string;
				recurrence?: string;
			},
		) => {
			const result = await manageTask(options, {
				action: parseAction(args.action),
				id: args.id,
				status: args.status,
				wake: args.wake,
				recurrence: args.recurrence,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: {
					kind: "task_manage",
					...result,
				},
			};
		},
	};
}
