import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { renderSubcommandUsage } from "../commands/catalog.js";
import { parseLocalTime } from "../shared/local-time.js";
import { clipText, errorMessage } from "../shared/text-utils.js";
import type { TaskBudget } from "../tasks/frontmatter.js";
import { normalizeTaskId, readActiveTasks, type TaskLedgerEntry } from "../tasks/ledger.js";
import { readTaskLog, renderTaskLogLine } from "../tasks/log.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { hasTaskSteer, queueTaskSteer } from "../tasks/steer.js";
import {
	openCycle,
	pauseTask as pauseTaskDocument,
	readStoredTask,
	redeemTicket,
	resumeTask as resumeTaskDocument,
	updateStoredTask,
} from "../tasks/store.js";
import { describeTicket } from "../tasks/ticket.js";

export interface HandleTasksCommandOptions {
	args: string;
	/** The channel directory; tasks live in `<channelDir>/tasks/`. */
	channelDir: string;
	/** Workspace directory; kept for callers that still pass it (doctor reads task-owned events). */
	workspaceDir?: string;
	channelId?: string;
	/** Optional immediate task wake, available in the long-lived DingTalk runtime. */
	dispatchTask?: (id: string) => Promise<boolean>;
}

/** `/tasks show <id>` head-snippet cap; the full file is always readable at its own path. */
const TASK_SHOW_MAX_CHARS = 2_400;
const SHOW_LOG_LINES = 8;

type TasksCommand =
	| { action: "list" }
	| { action: "show"; id: string }
	| { action: "log"; id: string; cycle?: string }
	| { action: "archive" }
	| { action: "doctor" }
	| { action: "pause"; id: string }
	| { action: "resume"; id: string; grants: Partial<TaskBudget> }
	| { action: "run"; id: string }
	| { action: "steer"; id: string; text: string }
	| { action: "reply"; id: string; text: string };

// Broadcast (subcommand names, args, descriptions, examples) lives once in commands/catalog.ts's
// `BUILT_IN_COMMANDS` entry for "tasks"; this just renders it (review 2026-08-24 §3.1).
function usage(): string {
	return renderSubcommandUsage("tasks");
}

/** `+steps 20`, `+rounds 2`, `+usd 5` — the three grants `/tasks resume` accepts. */
function parseGrants(rest: string): Partial<TaskBudget> {
	const grants: Partial<TaskBudget> = {};
	const pattern = /\+(steps|rounds|usd)\s+([0-9]+(?:\.[0-9]+)?)/g;
	for (const match of rest.matchAll(pattern)) {
		const value = Number(match[2]);
		if (!Number.isFinite(value) || value <= 0) continue;
		grants[match[1] as "steps" | "rounds" | "usd"] = value;
	}
	return grants;
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseTasksCommand(args: string): TasksCommand {
	const trimmed = args.trim();
	const parts = trimmed.split(/\s+/).filter(Boolean);
	const action = parts[0];

	if (!action || action === "list") {
		if (parts.length > 1) throw new Error("用法：/tasks list");
		return { action: "list" };
	}
	if (action === "archive" || action === "doctor") {
		if (parts.length > 1) throw new Error(`用法：/tasks ${action}`);
		return { action };
	}
	if (action === "show" || action === "pause" || action === "run") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error(`用法：/tasks ${action} <id>`);
		return { action, id };
	}
	if (action === "log") {
		const id = parts[1];
		if (!id || parts.length > 3) throw new Error("用法：/tasks log <id> [cycle]");
		return { action: "log", id, cycle: parts[2] };
	}
	if (action === "resume") {
		const id = parts[1];
		if (!id) throw new Error("用法：/tasks resume <id> [+steps N|+rounds N|+usd X]");
		return { action: "resume", id, grants: parseGrants(parts.slice(2).join(" ")) };
	}
	if (action === "steer" || action === "reply") {
		// Everything after the id is the message, verbatim — guidance is a sentence.
		const match = /^(?:steer|reply)\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
		if (!match) throw new Error(`用法：/tasks ${action} <id> <内容>`);
		return { action, id: match[1], text: match[2].trim() };
	}
	throw new Error(`未知的 /tasks 动作：${action}`);
}

function tasksDir(channelDir: string): string {
	return join(channelDir, "tasks");
}

/** Compact relative time, e.g. `12m` / `3h` / `2d`; `due` when already past. */
function relative(atMs: number | undefined, now: number): string | undefined {
	if (atMs === undefined || !Number.isFinite(atMs)) return undefined;
	const diffMs = atMs - now;
	if (diffMs <= 0) return "已到期";
	const minutes = Math.round(diffMs / 60000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

const STATE_LABEL: Record<string, string> = { open: "进行中", parked: "等待中", done: "已关闭" };

function cycleSummary(entry: TaskLedgerEntry): string | undefined {
	const cycle = entry.fields.cycle;
	if (!cycle) return undefined;
	const cost = cycle.usd > 0 ? `，$${cycle.usd.toFixed(2)}${cycle.usdEstimated ? "（含估算）" : ""}` : "";
	return `${cycle.id}：${cycle.steps} 步 / ${cycle.rounds} 轮${cost}`;
}

function ticketSummary(entry: TaskLedgerEntry, now: number): string | undefined {
	const ticket = entry.fields.ticket;
	if (!ticket) return undefined;
	const by = relative(parseLocalTime(ticket.by), now);
	return `${describeTicket(ticket)}${by ? `（兜底 ${by}）` : ""}`;
}

function renderListLine(entry: TaskLedgerEntry, channelDir: string, now: number): string {
	const bits = [`${entry.id} — ${entry.title}`, STATE_LABEL[entry.fields.state] ?? entry.fields.state];
	if (entry.fields.paused) bits.push(`已暂停（${entry.fields.paused.reason}）`);
	const ticket = ticketSummary(entry, now);
	if (ticket) bits.push(ticket);
	if (entry.plan) bits.push(`plan ${entry.plan.done}/${entry.plan.total}`);
	const cycle = cycleSummary(entry);
	if (cycle) bits.push(cycle);
	if (hasTaskSteer(channelDir, entry.id)) bits.push("有待处理的指示");
	if (!entry.readable) bits.push("⚠ frontmatter 不可读");
	return `- ${bits.join(" · ")}`;
}

async function listTasks(channelDir: string): Promise<string> {
	const now = Date.now();
	const entries = (await readActiveTasks(tasksDir(channelDir), now)).filter((entry) => !entry.fields.outcome);
	if (entries.length === 0) {
		return "暂无进行中的任务。\n让 Agent 用 task_create 建立一个长程任务后再回来查看。";
	}
	return [`**任务（${entries.length}）**`, ...entries.map((entry) => renderListLine(entry, channelDir, now))].join(
		"\n",
	);
}

async function showTask(channelDir: string, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = (await readStoredTask(channelDir, id, true)) ?? undefined;
	if (!document) return `未找到任务 \`${id}\`。\n用 /tasks list 查看进行中的任务，或 /tasks archive 查看已归档的。`;
	const now = Date.now();
	const entry = (await readActiveTasks(tasksDir(channelDir), now)).find((candidate) => candidate.id === id);

	const head: string[] = [`**任务 ${id}**`];
	head.push(`- 状态：${STATE_LABEL[document.fields.state] ?? document.fields.state}`);
	if (document.fields.paused) head.push(`- 已暂停（${document.fields.paused.by}）：${document.fields.paused.reason}`);
	if (document.fields.ticket) {
		const by = relative(parseLocalTime(document.fields.ticket.by), now);
		head.push(`- 等待：${describeTicket(document.fields.ticket)}${by ? `（兜底 ${by}）` : ""}`);
	}
	if (document.fields.schedule) head.push(`- 周期：${document.fields.schedule}`);
	const cycle = entry ? cycleSummary(entry) : undefined;
	if (cycle) head.push(`- 本周期：${cycle}`);
	if (document.fields.verify === "required") head.push("- 需要独立验收");

	const rounds = await readTaskLog(channelDir, id, { cycle: document.fields.cycle?.id, kinds: ["round"] });
	if (rounds.length > 0) {
		const verdicts = rounds.map((record) => (record.kind === "round" ? record.verdict : "")).join(" → ");
		head.push(`- 返工：${rounds.length} 轮（${verdicts}）`);
	}

	const log = await readTaskLog(channelDir, id, { limit: SHOW_LOG_LINES });
	const logLines = log.length > 0 ? ["", `**最近 ${log.length} 条日志**`, ...log.map(renderTaskLogLine)] : [];

	const body = clipText(document.body.trim(), TASK_SHOW_MAX_CHARS);
	return [...head, ...logLines, "", "**契约**", body, "", `完整日志：/tasks log ${id}`].join("\n");
}

async function listArchive(channelDir: string): Promise<string> {
	const archiveDir = join(tasksDir(channelDir), "archive");
	if (!existsSync(archiveDir)) return "暂无已归档任务。\n任务完成或取消后会出现在这里。";
	const files = (await readdir(archiveDir)).filter((name) => name.endsWith(".md")).sort();
	if (files.length === 0) return "暂无已归档任务。\n任务完成或取消后会出现在这里。";
	const lines: string[] = [];
	for (const filename of files.slice(0, 20)) {
		const id = filename.slice(0, -".md".length);
		const document = await readStoredTask(channelDir, id, true).catch(() => undefined);
		lines.push(
			`- ${id}${document?.fields.outcome ? ` · ${document.fields.outcome}` : ""}${document?.fields.closedAt ? ` · ${document.fields.closedAt}` : ""}`,
		);
	}
	if (files.length > 20) lines.push(`- （另有 ${files.length - 20} 个，见 tasks/archive/）`);
	return [`**已归档任务（${files.length}）**`, ...lines].join("\n");
}

async function showTaskLog(channelDir: string, idInput: string, cycle?: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const records = await readTaskLog(channelDir, id, { cycle, limit: 30 });
	if (records.length === 0) return `任务 \`${id}\` 暂无循环日志${cycle ? `（周期 ${cycle}）` : ""}。`;
	return [`**任务 ${id} 日志（${records.length} 条）**`, ...records.map(renderTaskLogLine)].join("\n");
}

export async function pauseTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await pauseTaskDocument(options.channelDir, id, {
		by: "user",
		reason: "用户通过 /tasks pause 暂停。",
	});
	if (!document) return `未找到任务 \`${id}\`。`;
	return `已暂停任务 \`${id}\`。当前阶段与等待票已保留；需要继续时用 /tasks resume ${id}。`;
}

export async function resumeTask(
	options: HandleTasksCommandOptions,
	idInput: string,
	grants: Partial<TaskBudget> = {},
): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await resumeTaskDocument(options.channelDir, id);
	if (!document) return `未找到任务 \`${id}\`。`;
	const granted: string[] = [];
	if (Object.keys(grants).length > 0) {
		await updateStoredTask(options.channelDir, id, (task) => {
			const budget = { ...task.fields.budget };
			for (const key of ["steps", "rounds", "usd"] as const) {
				const extra = grants[key];
				if (extra === undefined) continue;
				// A grant is *additional* headroom on top of whatever this cycle already spent, so
				// resuming a task that hit its ceiling actually lets it run rather than re-stopping
				// on the next step.
				const spent =
					key === "steps"
						? task.fields.cycle?.steps
						: key === "rounds"
							? task.fields.cycle?.rounds
							: task.fields.cycle?.usd;
				budget[key] = (spent ?? 0) + extra;
				granted.push(`${key}+${extra}`);
			}
			task.fields.budget = budget;
		});
	}
	return `已恢复任务 \`${id}\`${granted.length > 0 ? `（${granted.join("，")}）` : ""}。`;
}

async function runTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await readStoredTask(options.channelDir, id);
	if (!document) return `未找到任务 \`${id}\`。`;
	if (document.fields.paused) {
		return `任务 \`${id}\` 处于暂停状态；先用 /tasks resume ${id} 恢复，再 /tasks run。`;
	}
	if (!document.fields.cycle || document.fields.state === "parked") {
		const opened = await openCycle(options.channelDir, id);
		if (!opened) return `任务 \`${id}\` 无法开启新周期（可能已归档）。`;
	}
	const dispatched = await options.dispatchTask?.(id);
	return dispatched === false
		? `任务 \`${id}\` 已就绪，但频道队列暂时无法接受；driver 会在下一轮重试。`
		: `已立即唤醒任务 \`${id}\`。`;
}

async function steerTask(options: HandleTasksCommandOptions, idInput: string, text: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await readStoredTask(options.channelDir, id);
	if (!document) return `未找到任务 \`${id}\`。`;
	await queueTaskSteer(options.channelDir, id, text);
	return `已把这条指示排给任务 \`${id}\` 的下一步（不会打断当前正在跑的一步）。`;
}

/**
 * Answer an `ask` ticket: the reply becomes the next step's first input, and redeeming the ticket
 * is what actually reopens the task. A task parked on something else keeps its ticket — the reply
 * is still queued, because the user's words should not be dropped just because the timing was off.
 */
async function replyToTask(options: HandleTasksCommandOptions, idInput: string, text: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await readStoredTask(options.channelDir, id);
	if (!document) return `未找到任务 \`${id}\`。`;
	await queueTaskSteer(options.channelDir, id, text, "用户回答");
	const redeemed = await redeemTicket(options.channelDir, id, (ticket) => ticket.kind === "ask");
	if (!redeemed) {
		return `任务 \`${id}\` 当前并没有在等你的回答；内容已记下，下一步会看到。`;
	}
	if (options.dispatchTask) await options.dispatchTask(id);
	return `已回复任务 \`${id}\`，它会继续推进。`;
}

function issue(problem: string, nextStep: string): string {
	return `- ${problem}（下一步：${nextStep}）`;
}

/**
 * `/tasks doctor`, deliberately shrunk (spec 051, D11).
 *
 * Most of what v3's doctor looked for — `enabled` disagreeing with `control.stop`, `active` with
 * a future wake, an unparsable control block, a park with no recoverable source — cannot be
 * produced any more: the frontmatter normalizer and `resolveTicket` reject those states at write
 * time. What is left is what a *hand edit* can still create.
 */
async function doctor(options: HandleTasksCommandOptions): Promise<string> {
	const now = Date.now();
	const entries = await readActiveTasks(tasksDir(options.channelDir), now);
	const problems: string[] = [];

	for (const entry of entries) {
		if (!entry.readable) {
			problems.push(issue(`${entry.id} 的 frontmatter 不可读`, `用 edit 修复 tasks/${entry.id}.md 的首部`));
			continue;
		}
		if (entry.legacy) {
			problems.push(issue(`${entry.id} 仍是 v3 契约`, "重启一次让迁移器升级它，或用 edit 手动改写 frontmatter"));
		}
		if (entry.fields.state === "parked" && !entry.fields.ticket) {
			problems.push(
				issue(`${entry.id} 停泊但没有等待票`, `用 /tasks run ${entry.id} 重新开始，或让 Agent 重新停泊`),
			);
		}
		if (entry.expired && !entry.fields.paused) {
			problems.push(
				issue(`${entry.id} 的等待票已过兜底时限`, "driver 会在下一轮重开或通知；若一直没有，检查 daemon 是否在跑"),
			);
		}
		if (entry.fields.schedule && !entry.fields.cycle) {
			problems.push(issue(`${entry.id} 有 schedule 但没有周期记录`, `用 /tasks run ${entry.id} 开启第一个周期`));
		}
		const until = entry.fields.budget?.until ? parseLocalTime(entry.fields.budget.until) : undefined;
		if (until !== undefined && until < now && !entry.fields.paused) {
			problems.push(
				issue(`${entry.id} 已超过 budget.until`, `用 task_update 调整期限，或 /tasks pause ${entry.id}`),
			);
		}
	}

	if (problems.length === 0) return `**任务体检**\n- ${entries.length} 个任务，未发现问题。`;
	return [`**任务体检（${problems.length} 项）**`, ...problems].join("\n");
}

export async function handleTasksCommand(options: HandleTasksCommandOptions): Promise<string> {
	let command: TasksCommand;
	try {
		command = parseTasksCommand(options.args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${usage()}`;
	}

	try {
		if ("id" in command && command.id && command.action !== "show" && command.action !== "log") {
			return await withTaskMutation(options.channelDir, command.id, () => dispatchTasksCommand(options, command));
		}
		return await dispatchTasksCommand(options, command);
	} catch (error) {
		return `执行 /tasks ${command.action} 失败：${errorMessage(error)}`;
	}
}

async function dispatchTasksCommand(options: HandleTasksCommandOptions, command: TasksCommand): Promise<string> {
	switch (command.action) {
		case "list":
			return await listTasks(options.channelDir);
		case "show":
			return await showTask(options.channelDir, command.id);
		case "log":
			return await showTaskLog(options.channelDir, command.id, command.cycle);
		case "archive":
			return await listArchive(options.channelDir);
		case "pause":
			return await pauseTask(options, command.id);
		case "resume":
			return await resumeTask(options, command.id, command.grants);
		case "run":
			return await runTask(options, command.id);
		case "steer":
			return await steerTask(options, command.id, command.text);
		case "reply":
			return await replyToTask(options, command.id, command.text);
		case "doctor":
			return await doctor(options);
	}
}
