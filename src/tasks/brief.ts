import { join } from "node:path";
import { PLAYBOOKS_DIR } from "../paths.js";
import { effectiveBudget } from "./budget.js";
import type { TaskFrontmatterV4 } from "./frontmatter.js";
import { readTaskLog, renderTaskLogLine } from "./log.js";
import { consumeTaskSteer } from "./steer.js";
import { readStoredTask } from "./store.js";
import { describeTicket } from "./ticket.js";

/** How many loop-log lines a step brief carries. Older records stay addressable via `task_log`. */
export const BRIEF_LOG_LINES = 8;

export interface TaskBriefInput {
	channelDir: string;
	taskId: string;
	/** Why this step is running: new cycle, ticket redeemed, ticket expired, previous step continued. */
	reason?: string;
}

/**
 * The turn input for one task loop step (spec 051, D3).
 *
 * The authored contract is injected whole; authors must keep it short. The history
 * is the last few log lines rather than the 24 KB of closed cycles v3 pasted into every wake. Any
 * pending `/tasks steer` or `/tasks reply` is consumed here and put first — it is the one thing in
 * the brief that is genuinely new since the previous step.
 */
export async function buildTaskStepBrief(input: TaskBriefInput): Promise<string | undefined> {
	const document = await readStoredTask(input.channelDir, input.taskId);
	if (!document) return undefined;

	const steer = await consumeTaskSteer(input.channelDir, input.taskId);
	const log = await readTaskLog(input.channelDir, input.taskId, {
		cycle: document.fields.cycle?.id,
		limit: BRIEF_LOG_LINES,
	});

	const blocks: string[] = [`[TASK_STEP:${input.taskId}]`];
	if (input.reason) blocks.push(input.reason);
	// Reuse durable history instead of a new pending-wake flag. An expiry remains relevant until
	// a later step records what recovery did; a verifier round in between does not consume it.
	const lastTransition = [...log].reverse().find((record) => record.kind === "expired" || record.kind === "step");
	if (lastTransition?.kind === "expired") {
		blocks.push(
			`<task_recovery kind="expired">\n等待票过期：${lastTransition.ticket}。先核对来源的真实状态，再决定继续、换票或请求用户决定。\n</task_recovery>`,
		);
	}
	if (steer) blocks.push(`<user_guidance>\n${steer}\n</user_guidance>`);
	blocks.push(
		`契约文件：${document.path}\n首次执行前读取 ${join(PLAYBOOKS_DIR, "task-loop.md")}；已在当前上下文中完整读过则复用。`,
	);
	blocks.push(`<task_contract id="${input.taskId}">\n${document.body.trim()}\n</task_contract>`);
	if (log.length > 0) {
		blocks.push(`<task_log recent="${log.length}">\n${log.map(renderTaskLogLine).join("\n")}\n</task_log>`);
	}
	blocks.push(`<task_state>\n${renderState(document.fields)}\n</task_state>`);
	blocks.push(
		"推进这个任务的下一个具体步骤，然后必须调用 task_step_end 收尾：" +
			"continue（还能继续）/ park（等一个真实来源）/ done（本周期完成）/ blocked（需要用户决定）。" +
			"默认不向用户发言；确实需要告诉用户时用 notify。",
	);
	return blocks.join("\n\n");
}

function renderState(fields: TaskFrontmatterV4): string {
	const budget = effectiveBudget(fields);
	const cycle = fields.cycle;
	const lines = [`state: ${fields.state}`];
	if (fields.schedule) lines.push(`schedule: ${fields.schedule}`);
	if (fields.verify === "required") lines.push("verify: required（完成前需要一次独立验收 PASS）");
	if (fields.ticket) lines.push(`ticket: ${describeTicket(fields.ticket)}（兜底 ${fields.ticket.by}）`);
	if (cycle) {
		lines.push(
			`cycle ${cycle.id}: ${cycle.steps}/${budget.steps} 步 · ${cycle.rounds}/${budget.rounds} 轮 · ` +
				`$${cycle.usd.toFixed(2)}/$${budget.usd}${cycle.usdEstimated ? "（含估算）" : ""}`,
		);
	}
	if (budget.until) lines.push(`deadline: ${budget.until}`);
	return lines.join("\n");
}
