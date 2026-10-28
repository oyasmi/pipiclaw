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
	const document = await createTaskDocument({ deskDir: options.deskDir, id, input, channel: options.channelId });
	options.control?.created(options.desk, document.id);
	return {
		action: "create",
		id: document.id,
		path: document.path,
		state: document.fields.state,
		notice: `已创建任务 \`${document.id}\`，排队后在后台执行；用户命令 /tasks show ${document.id} 可查看。`,
	};
}
