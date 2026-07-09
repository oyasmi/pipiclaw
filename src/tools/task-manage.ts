import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { parseScheduledEventContent } from "../runtime/events.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isTaskScheduleEvent, taskEventPrefix, taskScheduleEventFilename } from "../shared/task-events.js";
import {
	normalizeTaskId,
	parseTaskFrontmatter,
	readActiveTasks,
	renderStandardTaskBody,
	taskBody,
} from "../shared/task-ledger.js";

const SETTABLE_STATUSES = ["open", "in-progress", "awaiting-user", "blocked"] as const;

const taskManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the ledger change (shown to the user)" }),
	action: Type.Union([Type.Literal("create"), Type.Literal("set"), Type.Literal("done"), Type.Literal("list")], {
		description:
			'"create" writes a standard task skeleton; "set" updates status/wake/recurrence; "done" closes it out and requires summary/evidence; "list" returns active tasks.',
	}),
	id: Type.Optional(Type.String({ description: "Task id (filename without .md). Required for create/set/done." })),
	title: Type.Optional(Type.String({ description: "Required for create: task title used as the H1 heading." })),
	goal: Type.Optional(Type.String({ description: "Required for create: concise task goal." })),
	dod: Type.Optional(Type.String({ description: "Required for create: acceptance criteria / definition of done." })),
	manual: Type.Optional(Type.String({ description: "Optional for create: initial operating steps or checklist." })),
	status: Type.Optional(
		Type.Union(
			SETTABLE_STATUSES.map((status) => Type.Literal(status)),
			{ description: "New status for create/set. To close a task use action done, not status." },
		),
	),
	wake: Type.Optional(
		Type.String({
			description:
				"ISO8601 earliest-recheck time for set; empty string clears it. Keep in sync with any .checkin event.",
		}),
	),
	recurrence: Type.Optional(Type.String({ description: "Annotation only (e.g. 每周一); empty string clears it." })),
	summary: Type.Optional(Type.String({ description: "Required for done: concise completion summary." })),
	evidence: Type.Optional(
		Type.String({
			description:
				"Required for done: verification evidence (tests, commands, review result, external confirmation, or a clear not-run reason).",
		}),
	),
	residualRisk: Type.Optional(Type.String({ description: "Optional for done: remaining risk or follow-up note." })),
});

export type TaskManageAction = "create" | "set" | "done" | "list";

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
	title?: string;
	goal?: string;
	dod?: string;
	manual?: string;
	status?: string;
	wake?: string;
	recurrence?: string;
	summary?: string;
	evidence?: string;
	residualRisk?: string;
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
	if (action === "create" || action === "set" || action === "done" || action === "list") {
		return action;
	}
	throw new Error('Unsupported task action. Use "create", "set", "done", or "list".');
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

function requiredField(value: string | undefined, field: string, action: string): string {
	const trimmed = value?.trim();
	if (!trimmed) {
		throw new Error(`action "${action}" requires ${field}.`);
	}
	return trimmed;
}

function requireNonEmpty(value: string | undefined, field: string): string {
	return requiredField(value, field, "done");
}

function markdownValue(value: string): string {
	const lines = value.trim().split(/\r?\n/);
	if (lines.length === 1) return lines[0];
	return lines.map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
}

function appendCompletionEvidence(body: string, request: TaskManageRequest): string {
	const summary = requireNonEmpty(request.summary, "summary");
	const evidence = requireNonEmpty(request.evidence, "evidence");
	const lines = [
		"## Completion Evidence",
		"",
		`- Summary: ${markdownValue(summary)}`,
		`- Evidence: ${markdownValue(evidence)}`,
	];
	const residualRisk = request.residualRisk?.trim();
	if (residualRisk) {
		lines.push(`- Residual risk: ${markdownValue(residualRisk)}`);
	}
	const normalizedBody = body.endsWith("\n") ? body.replace(/\n+$/, "\n") : `${body}\n`;
	return `${normalizedBody}\n${lines.join("\n")}\n`;
}

function normalizeCreateStatus(status: string | undefined): (typeof SETTABLE_STATUSES)[number] {
	if (status === undefined) return "open";
	if ((SETTABLE_STATUSES as readonly string[]).includes(status)) {
		return status as (typeof SETTABLE_STATUSES)[number];
	}
	throw new Error(`Invalid status "${status}". Use one of ${SETTABLE_STATUSES.join(", ")}.`);
}

function renderTaskSkeleton(request: TaskManageRequest): { fields: TaskFields; body: string } {
	const title = requiredField(request.title, "title", "create");
	const goal = requiredField(request.goal, "goal", "create");
	const dod = requiredField(request.dod, "dod", "create");
	const fields = applySet({ status: normalizeCreateStatus(request.status) }, request);
	const body = renderStandardTaskBody({ title, goal, dod, manual: request.manual });
	return { fields, body };
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

async function createTask(options: TaskManageToolOptions, request: TaskManageRequest): Promise<TaskManageResult> {
	if (!request.id) throw new Error('action "create" requires an id.');
	const id = normalizeTaskId(request.id);
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const archivePath = join(dir, "archive", `${id}.md`);
	if (existsSync(taskPath)) {
		throw new Error(`Task "${id}" already exists; use action "set" or edit the body instead.`);
	}
	if (existsSync(archivePath)) {
		throw new Error(`Archived task "${id}" already exists; choose a new id or restore it manually first.`);
	}
	const { fields, body } = renderTaskSkeleton(request);
	await mkdir(dir, { recursive: true });
	await writeFileAtomically(taskPath, renderTaskFile(fields, body));
	return {
		action: "create",
		id,
		path: toWorkspacePath(options, taskPath),
		status: fields.status,
		notice: `已创建任务 \`${id}\`（status: ${fields.status}）。`,
	};
}

/**
 * On close-out, keep only the task's recurring cadence event
 * (`task.<channelId>.<id>.schedule`) and delete every other task-owned event.
 *
 * A task may also own temporary periodic events (for example an agentmux idle sensor).
 * Those are lifecycle check-ins, not proof that the task itself is recurring, so they
 * must not prevent a one-shot task from being archived.
 */
async function cleanupTaskEvents(
	options: TaskManageToolOptions,
	id: string,
): Promise<{ deleted: string[]; hasSchedule: boolean }> {
	const dir = eventsDir(options);
	if (!existsSync(dir)) return { deleted: [], hasSchedule: false };

	const prefix = taskEventPrefix(options.channelId, id);
	const scheduleFilename = taskScheduleEventFilename(options.channelId, id);
	const deleted: string[] = [];
	let hasSchedule = false;

	for (const filename of (await readdir(dir)).sort()) {
		if (!filename.endsWith(".json") || !filename.startsWith(prefix)) continue;
		const eventPath = join(dir, filename);
		let type: string | undefined;
		try {
			type = parseScheduledEventContent(await readFile(eventPath, "utf-8"), filename).type;
		} catch {
			continue; // can't classify → leave it for /events to handle
		}
		if (filename === scheduleFilename && isTaskScheduleEvent({ use: "schedule", event: { type } })) {
			hasSchedule = true; // the cadence lives on for the next cycle
			continue;
		}
		await unlink(eventPath);
		deleted.push(filename.slice(0, -".json".length));
	}
	return { deleted, hasSchedule };
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
	const bodyWithEvidence = appendCompletionEvidence(body, request);

	await writeFileAtomically(taskPath, renderTaskFile({ ...fields, status: "done" }, bodyWithEvidence));
	const { deleted, hasSchedule } = await cleanupTaskEvents(options, id);

	// Periodic task → sleeps in place until its schedule fires next; one-shot → archive.
	let archived = false;
	let finalPath = taskPath;
	if (!hasSchedule) {
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
		case "create":
			return createTask(options, request);
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
			"(requiring summary/evidence, archiving one-shot tasks, and cleaning up residual events), or list active " +
			"tasks. Write the task body (goal, DoD, manual, cycle log) with write/edit; this tool owns only the " +
			"frontmatter and close-out evidence.",
		parameters: taskManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				label: string;
				action: string;
				id?: string;
				title?: string;
				goal?: string;
				dod?: string;
				manual?: string;
				status?: string;
				wake?: string;
				recurrence?: string;
				summary?: string;
				evidence?: string;
				residualRisk?: string;
			},
		) => {
			const result = await manageTask(options, {
				action: parseAction(args.action),
				id: args.id,
				title: args.title,
				goal: args.goal,
				dod: args.dod,
				manual: args.manual,
				status: args.status,
				wake: args.wake,
				recurrence: args.recurrence,
				summary: args.summary,
				evidence: args.evidence,
				residualRisk: args.residualRisk,
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
