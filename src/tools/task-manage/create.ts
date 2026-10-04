import { validateTaskContractInput } from "../../tasks/contract-input.js";
import { createTaskDocument } from "../../tasks/create.js";
import type { TaskCreateRequest, TaskManageResult, TaskManageToolOptions } from "./types.js";

export async function createTask(
	options: TaskManageToolOptions,
	request: TaskCreateRequest,
): Promise<TaskManageResult> {
	const { id, ...contract } = request;
	// Same validator the event-template admission uses, so a task that can be created from a
	// template can be created here and the other way round.
	const input = validateTaskContractInput(contract);
	const document = await createTaskDocument({ channelDir: options.channelDir, id, input });
	return {
		action: "create",
		id: document.id,
		path: document.path,
		state: document.fields.state,
		notice: `已创建任务 \`${document.id}\`（state: ${document.fields.state}）。`,
	};
}
