import { truncate } from "../shared/text-utils.js";
import type { GuardBreach } from "./state.js";

/**
 * The messages the runtime sends a task's report channel without asking a model (spec 064, D29).
 * User copy under spec 053: Chinese, the four markers, no tool names or internal tags, and every
 * next step is something the user can type.
 */

/** A `task_ask` question, delivered once the step ends. */
export function askReceipt(id: string, question: string): string {
	return `⚠️ 任务 \`${id}\` 需要你的决定：${question}\n直接回复我，或用 \`/tasks msg ${id} <内容>\` 回答。`;
}

/** The runtime paused the task: budget, idle, timeout or errors. A budget stop says how to give it more. */
export function pausedReceipt(id: string, title: string, reason: string, breach?: GuardBreach): string {
	const grant = breach === "steps" ? " +steps 10" : breach === "usd" ? " +usd 5" : "";
	const resume = grant ? "继续并追加预算" : "继续";
	return (
		`🛑 任务 \`${id}\`（${title}）已暂停：${reason}。\n` +
		`查看：\`/tasks show ${id}\`；${resume}：\`/tasks resume ${id}${grant}\`\n` +
		`不再需要：\`/tasks cancel ${id}\``
	);
}

export function completedReceipt(id: string, title: string): string {
	return `✅ 任务 \`${id}\`（${title}）已完成。`;
}

/** The leader cancelled its own task. */
export function cancelledByLeaderReceipt(id: string, title: string, note: string): string {
	return `🛑 任务 \`${id}\`（${title}）已取消：${truncate(note.replace(/\s+/g, " "), 160)}`;
}

/** The user cancelled from another channel of the desk; the report channel should not be left wondering. */
export function cancelledByUserReceipt(id: string, title: string): string {
	return `🛑 任务 \`${id}\`（${title}）已被取消。`;
}
