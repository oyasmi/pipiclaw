import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomically } from "../../shared/atomic-file.js";
import { normalizeTaskId, uncheckedTaskAcceptanceItems } from "../../tasks/ledger.js";
import { RecoverableToolError } from "../tool-details.js";
import { renderTaskFile, renderTaskSkeleton, tasksDir } from "./shared.js";
import type { TaskCreateRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";

export async function createTask(
	options: TaskManageToolOptions,
	request: TaskCreateRequest,
): Promise<TaskManageResult> {
	const id = normalizeTaskId(request.id);
	const dir = tasksDir(options);
	const taskPath = join(dir, `${id}.md`);
	const archivePath = join(dir, "archive", `${id}.md`);
	if (existsSync(taskPath)) {
		throw new RecoverableToolError(`Task "${id}" already exists; use task_update or edit the body instead.`);
	}
	if (existsSync(archivePath)) {
		throw new RecoverableToolError(
			`Archived task "${id}" already exists; choose a new id or restore it manually first.`,
		);
	}
	const { fields, body } = renderTaskSkeleton(request);
	const badDod = uncheckedTaskAcceptanceItems(body).find((item) => item.startsWith("DoD has no checklist items"));
	if (badDod) throw new RecoverableToolError(badDod);
	await mkdir(dir, { recursive: true });
	await writeFileAtomically(taskPath, renderTaskFile(fields, body));
	return {
		action: "create",
		id,
		path: taskPath,
		status: fields.status,
		notice: `已创建任务 \`${id}\`（status: ${fields.status}${fields.wake ? `, 首次唤醒: ${fields.wake}` : ""}）。`,
	};
}
