import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { formatLocalTime } from "../shared/local-time.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { createUsage } from "./budget.js";
import type { TaskCreateInput } from "./contract-input.js";
import type { TaskFrontmatter } from "./frontmatter.js";
import { normalizeTaskId, renderStandardTaskBody, renderTaskDocument } from "./ledger.js";
import type { StoredTaskDocument } from "./store.js";
import { archivedTaskPath, taskPath, tasksDir } from "./store.js";

export interface CreateTaskDocumentOptions {
	channelDir: string;
	id: string;
	input: TaskCreateInput;
	/** The event whose template spawned this instance. */
	origin?: string;
	now?: Date;
}

/**
 * Write a new task file, `open`, with its usage clock started. Shared by `task_create` and the
 * event-template spawner so both produce byte-identical documents.
 */
export async function createTaskDocument(options: CreateTaskDocumentOptions): Promise<StoredTaskDocument> {
	const id = normalizeTaskId(options.id);
	const path = taskPath(options.channelDir, id);
	if (existsSync(path)) {
		throw new RecoverableToolError(`Task "${id}" already exists; use task_update or edit the body instead.`);
	}
	if (existsSync(archivedTaskPath(options.channelDir, id))) {
		throw new RecoverableToolError(
			`Archived task "${id}" already exists; choose a new id or restore it manually first.`,
		);
	}
	const now = options.now ?? new Date();
	const fields: TaskFrontmatter = {
		state: "open",
		origin: options.origin,
		usage: createUsage(now),
		budget: options.input.budget,
	};
	const body = renderStandardTaskBody(options.input);
	await writeFileAtomically(join(tasksDir(options.channelDir), `${id}.md`), renderTaskDocument(fields, body));
	return { id, path, fields, body };
}

/** The local-time stamp spawned instances carry in their id: `YYYYMMDD-HHmm`. */
export function instanceStamp(at: Date): string {
	return formatLocalTime(at).slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
}
