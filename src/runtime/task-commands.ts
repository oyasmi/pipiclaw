import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { renderSubcommandUsage } from "../commands/catalog.js";
import { parseLocalTime } from "../shared/local-time.js";
import { clipText, errorMessage } from "../shared/text-utils.js";
import { buildTaskBoard, renderTaskBoard } from "../tasks/board.js";
import type { TaskBudget } from "../tasks/frontmatter.js";
import { normalizeTaskId, readActiveTasks, type TaskLedgerEntry } from "../tasks/ledger.js";
import { readTaskLog, renderTaskLogLine } from "../tasks/log.js";
import { withTaskMutation } from "../tasks/mutation-lock.js";
import { hasTaskSteer, queueTaskSteer } from "../tasks/steer.js";
import {
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
	/** Optional immediate task wake, available in the long-lived DingTalk runtime. */
	dispatchTask?: (id: string) => Promise<boolean>;
}

/** `/tasks show <id>` head-snippet cap; the full file is always readable at its own path. */
const TASK_SHOW_MAX_CHARS = 2_400;
const SHOW_LOG_LINES = 8;
/** A backstop this far past due means the driver is not running, not that it is merely about to act. */
const EXPIRED_GRACE_MS = 60 * 60 * 1000;

type TasksCommand =
	| { action: "list" }
	| { action: "show"; id: string }
	| { action: "log"; id: string }
	| { action: "archive" }
	| { action: "doctor" }
	| { action: "pause"; id: string }
	| { action: "resume"; id: string; grants: Partial<TaskBudget> }
	| { action: "steer"; id: string; text: string }
	| { action: "reply"; id: string; text: string };

// Broadcast (subcommand names, args, descriptions, examples) lives once in commands/catalog.ts's
// `BUILT_IN_COMMANDS` entry for "tasks"; this just renders it (review 2026-08-24 §3.1).
function usage(): string {
	return renderSubcommandUsage("tasks");
}

/** `+steps 20`, `+usd 5` — the two grants `/tasks resume` accepts. */
function parseGrants(rest: string): Partial<TaskBudget> {
	const grants: Partial<TaskBudget> = {};
	const pattern = /\+(steps|usd)\s+([0-9]+(?:\.[0-9]+)?)/g;
	for (const match of rest.matchAll(pattern)) {
		const value = Number(match[2]);
		if (!Number.isFinite(value) || value <= 0) continue;
		grants[match[1] as "steps" | "usd"] = value;
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
	if (action === "show" || action === "pause" || action === "log") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error(`用法：/tasks ${action} <id>`);
		return { action, id };
	}
	if (action === "resume") {
		const id = parts[1];
		if (!id) throw new Error("用法：/tasks resume <id> [+steps N|+usd X]");
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

function usageSummary(entry: TaskLedgerEntry): string | undefined {
	const usage = entry.fields.usage;
	if (!usage) return undefined;
	const cost = usage.usd > 0 ? `，$${usage.usd.toFixed(2)}${usage.usdEstimated ? "（含估算）" : ""}` : "";
	return `${usage.steps} 步${cost}`;
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
	if (entry.items) bits.push(`items ${entry.items.done}/${entry.items.total}`);
	if (entry.fields.origin) bits.push(`来自 ${entry.fields.origin}`);
	const usage = usageSummary(entry);
	if (usage) bits.push(usage);
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
	if (document.fields.origin) head.push(`- 来自事件：${document.fields.origin}`);
	const usage = entry ? usageSummary(entry) : undefined;
	if (usage) head.push(`- 用量：${usage}`);

	const board = await buildTaskBoard(channelDir, id, document.body);
	const boardLines = board ? ["", "**团队看板**", renderTaskBoard(board, now)] : [];

	const log = await readTaskLog(channelDir, id, {
		kinds: ["step", "expired", "close", "note"],
		limit: SHOW_LOG_LINES,
	});
	const logLines = log.length > 0 ? ["", `**最近 ${log.length} 条日志**`, ...log.map(renderTaskLogLine)] : [];

	const body = clipText(document.body.trim(), TASK_SHOW_MAX_CHARS);
	return [...head, ...boardLines, ...logLines, "", "**契约**", body, "", `完整日志：/tasks log ${id}`].join("\n");
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

async function showTaskLog(channelDir: string, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const records = await readTaskLog(channelDir, id, { limit: 30 });
	if (records.length === 0) return `任务 \`${id}\` 暂无循环日志。`;
	return [`**任务 ${id} 日志（${records.length} 条）**`, ...records.map(renderTaskLogLine)].join("\n");
}

async function pauseTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
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
			for (const key of ["steps", "usd"] as const) {
				const extra = grants[key];
				if (extra === undefined) continue;
				// A grant is *additional* headroom on top of whatever the task already spent, so
				// resuming a task that hit its ceiling actually lets it run rather than re-stopping
				// on the next step.
				const spent = key === "steps" ? task.fields.usage?.steps : task.fields.usage?.usd;
				budget[key] = (spent ?? 0) + extra;
				granted.push(`${key}+${extra}`);
			}
			task.fields.budget = budget;
		});
	}
	return `已恢复任务 \`${id}\`${granted.length > 0 ? `（${granted.join("，")}）` : ""}。`;
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
 * `/tasks doctor`, deliberately small (spec 051, D11; spec 052, D11).
 *
 * Most of what older doctors looked for cannot be produced any more: the frontmatter normalizer
 * and `resolveTicket` reject those states at write time. What is left is what a *hand edit*, or a
 * conversion that did not run, can still create.
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
			problems.push(
				issue(
					`${entry.id} 仍含旧版本的字段（cycle / schedule / verify 等）`,
					"重启一次让转换器升级它，或用 edit 手动改写 frontmatter",
				),
			);
		}
		const by = entry.fields.ticket ? parseLocalTime(entry.fields.ticket.by) : undefined;
		if (entry.expired && !entry.fields.paused && by !== undefined && by < now - EXPIRED_GRACE_MS) {
			problems.push(
				issue(`${entry.id} 的等待票已过兜底时限超过 1 小时`, "driver 本该重开或通知；检查 daemon 是否在跑"),
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
			return await showTaskLog(options.channelDir, command.id);
		case "archive":
			return await listArchive(options.channelDir);
		case "pause":
			return await pauseTask(options, command.id);
		case "resume":
			return await resumeTask(options, command.id, command.grants);
		case "steer":
			return await steerTask(options, command.id, command.text);
		case "reply":
			return await replyToTask(options, command.id, command.text);
		case "doctor":
			return await doctor(options);
	}
}
