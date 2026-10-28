import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { createUsage } from "./budget.js";
import { normalizeTaskId, renderStandardTaskBody, renderTaskDocument } from "./contract.js";
import type { TaskCreateInput } from "./contract-input.js";
import type { TaskFrontmatter } from "./frontmatter.js";
import { withTaskMutation } from "./mutation-lock.js";
import type { StoredTaskDocument } from "./store.js";
import { archivedTaskPath, taskPath, tasksDir } from "./store.js";

export interface CreateTaskDocumentOptions {
	deskDir: string;
	id: string;
	input: TaskCreateInput;
	/** The delivery channel (spec 058, D13): the creating turn's channel, or the spawning event's. */
	channel: string;
	/** The event whose template spawned this instance. */
	origin?: string;
	now?: Date;
}

/**
 * Write a new task file, `queued`, with its usage clock started. Shared by `task_create` and the
 * event-template spawner so both produce byte-identical documents.
 */
export function createTaskDocument(options: CreateTaskDocumentOptions): Promise<StoredTaskDocument> {
	// Locked like every other task write, so two processes cannot both pass the existence check.
	return withTaskMutation(options.deskDir, options.id, () => writeNewTask(options));
}

async function writeNewTask(options: CreateTaskDocumentOptions): Promise<StoredTaskDocument> {
	const id = normalizeTaskId(options.id);
	const path = taskPath(options.deskDir, id);
	if (existsSync(path)) {
		throw new RecoverableToolError(
			`Task "${id}" already exists; choose a new id, or edit its contract file directly.`,
		);
	}
	if (existsSync(archivedTaskPath(options.deskDir, id))) {
		throw new RecoverableToolError(
			`Archived task "${id}" already exists; choose a new id or restore it manually first.`,
		);
	}
	const now = options.now ?? new Date();
	const fields: TaskFrontmatter = {
		state: "queued",
		channel: options.channel,
		origin: options.origin,
		usage: createUsage(now),
		budget: options.input.budget,
	};
	const body = renderStandardTaskBody(options.input);
	await writeFileAtomically(join(tasksDir(options.deskDir), `${id}.md`), renderTaskDocument(fields, body));
	return { id, path, fields, body };
}

/** The local-time stamp spawned instances carry in their id: `YYYYMMDD-HHmm`. */
export function instanceStamp(at: Date): string {
	return formatLocalTime(at).slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
}
