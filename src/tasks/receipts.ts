import { capReply } from "../commands/reply-limits.js";
import { formatElapsedZh } from "../shared/format.js";
import { parseLocalTime } from "../shared/local-time.js";
import { truncate } from "../shared/text-utils.js";
import { taskCostSummary } from "./budget.js";
import { parseTaskItems } from "./contract.js";
import type { RetainedWorktreeInfo } from "./control.js";
import type { TaskFrontmatter } from "./frontmatter.js";
import type { GuardBreach } from "./state.js";

/**
 * The messages the runtime sends a task's report channel without asking a model (spec 064, D29).
 * User copy under spec 053: Chinese, the four markers, no tool names or internal tags, and every
 * next step is something the user can type.
 */

/** A `task_report` message, tagged with its task id when the leader did not already name it. */
export function reportReceipt(id: string, text: string): string {
	if (text.includes(id)) return text;
	return `**任务 \`${id}\` 汇报**\n${text}`;
}

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

export function formatRetainedWorktreeLines(retained?: readonly RetainedWorktreeInfo[]): string[] {
	if (!retained || retained.length === 0) return [];
	const lines = retained.slice(0, 3).map((item) => {
		const ref = item.branch ? `分支 \`${item.branch}\`` : `提交 \`${item.headSha.slice(0, 12)}\``;
		const why = item.reason === "dirty" ? "含未提交改动" : "含未合并提交";
		return `- ⚠️ 保留未合并工作树：\`${item.path}\`（委派 \`${item.runId}\`，${ref}，${why}）`;
	});
	if (retained.length > 3) {
		lines.push(`- ⚠️ 另有 ${retained.length - 3} 个未合并工作树已保留在本地仓库`);
	}
	return lines;
}

export function completedReceipt(
	id: string,
	title: string,
	document: { fields: TaskFrontmatter; body: string },
	closedAt: string,
	retainedWorktrees?: readonly RetainedWorktreeInfo[],
): string {
	const usage = document.fields.usage;
	const since = usage ? parseLocalTime(usage.startedAt) : undefined;
	const end = parseLocalTime(closedAt);
	const items = parseTaskItems(document.body);
	const dropped = items?.items.filter((item) => item.status === "dropped").map((item) => item.id) ?? [];
	return capReply(
		[
			`**✅ 任务 \`${id}\`（${title}）已完成**`,
			...(since !== undefined && end !== undefined
				? [`- 历时：${formatElapsedZh(end - since)}（含排队和等待）`]
				: []),
			...(usage ? [`- 用量：${usage.steps} 步 · ${taskCostSummary(usage)}`] : []),
			...(items
				? [`- 工作项：${items.done}/${items.total}${dropped.length > 0 ? `；已放弃：${dropped.join("、")}` : ""}`]
				: []),
			...formatRetainedWorktreeLines(retainedWorktrees),
		].join("\n"),
		{ nextStepHint: `用 \`/tasks show ${id}\` 查看详情` },
	).text;
}

/** The leader cancelled its own task. */
export function cancelledByLeaderReceipt(
	id: string,
	title: string,
	note: string,
	retainedWorktrees?: readonly RetainedWorktreeInfo[],
): string {
	const retained = formatRetainedWorktreeLines(retainedWorktrees);
	return capReply(
		[`🛑 任务 \`${id}\`（${title}）已取消：${truncate(note.replace(/\s+/g, " "), 160)}`, ...retained].join("\n"),
		{ nextStepHint: `用 \`/tasks log ${id}\` 查看记录` },
	).text;
}

/** The user cancelled from another channel of the desk; the report channel should not be left wondering. */
export function cancelledByUserReceipt(
	id: string,
	title: string,
	retainedWorktrees?: readonly RetainedWorktreeInfo[],
): string {
	const retained = formatRetainedWorktreeLines(retainedWorktrees);
	return capReply([`🛑 任务 \`${id}\`（${title}）已被取消。`, ...retained].join("\n"), {
		nextStepHint: `用 \`/tasks log ${id}\` 查看记录`,
	}).text;
}
