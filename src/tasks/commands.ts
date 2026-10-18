/**
 * `/tasks`: the user's control path for the channel's long-horizon tasks (list, show, log, pause,
 * resume, run, reply, steer, archive, doctor).
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply, flattenMarkdownForChat } from "../commands/reply-limits.js";
import { formatSpanZh } from "../shared/format.js";
import { parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { buildTaskBoard, renderTaskBoardForUser } from "./board.js";
import { normalizeTaskId, readActiveTasks, type TaskLedgerEntry } from "./contract.js";
import { type TaskBudget, taskStateLabel } from "./frontmatter.js";
import {
	readTaskLog,
	renderTaskLogLineForUser,
	taskArchiveLogPath,
	taskLogIsArchived,
	taskLogPath,
} from "./loop-log.js";
import { withTaskMutation } from "./mutation-lock.js";
import { hasTaskSteer, queueTaskSteer } from "./steer.js";
import {
	archivedTaskPath,
	pauseTask as pauseTaskDocument,
	readStoredTask,
	redeemTicket,
	resumeTask as resumeTaskDocument,
	taskPath,
	updateStoredTask,
} from "./store.js";
import { describeTicketForUser } from "./ticket.js";

/** What `/tasks` needs to say about a delivery channel (structurally `channel/channel-id.ts`'s `ChannelDescription`). */
interface TaskChannelDescription {
	label: string;
	/** Still bound to this dot; false means the task is suspended (spec 058, D8). */
	boundHere: boolean;
}

export interface HandleTasksCommandOptions {
	args: string;
	/** The dot directory; tasks live in `<dotDir>/tasks/`. */
	dotDir: string;
	/** The channel the command was typed in: a task delivering elsewhere names its channel. */
	currentChannelId: string;
	describeChannel: (channelId: string) => TaskChannelDescription;
	/** Optional immediate task wake, available in the long-lived DingTalk runtime. */
	dispatchTask?: (id: string) => Promise<boolean>;
}

/** `/tasks show <id>` contract excerpt; the full file is always readable at its own path. */
const TASK_SHOW_CONTRACT_CHARS = 500;
const SHOW_LOG_LINES = 5;
/** `/tasks log <id>`: the most recent records; older ones are in the `.jsonl` it names. */
const LOG_LINES = 15;
const ARCHIVE_LIST_LIMIT = 20;
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
	throw new Error(`未知子命令 \`${action}\`。`);
}

function tasksDir(dotDir: string): string {
	return join(dotDir, "tasks");
}

/** `（最晚 3 小时后重新检查）` — when the runtime looks at a parked task again no matter what. */
function backstopHint(by: string, now: number): string {
	const atMs = parseLocalTime(by);
	if (atMs === undefined || !Number.isFinite(atMs)) return "";
	const diffMs = atMs - now;
	return diffMs <= 0 ? "（已过最晚检查时间）" : `（最晚 ${formatSpanZh(diffMs)}后重新检查）`;
}

function usageSummary(entry: TaskLedgerEntry): string | undefined {
	const usage = entry.fields.usage;
	if (!usage) return undefined;
	const cost = usage.usd > 0 ? ` · 花费 $${usage.usd.toFixed(2)}${usage.usdEstimated ? "（含估算）" : ""}` : "";
	return `已用 ${usage.steps} 步${cost}`;
}

function ticketSummary(entry: TaskLedgerEntry, now: number): string | undefined {
	const ticket = entry.fields.ticket;
	return ticket ? `${describeTicketForUser(ticket)}${backstopHint(ticket.by, now)}` : undefined;
}

/** The delivery-channel note for a task, or `undefined` when it delivers here and is live. */
function deliveryNote(channel: string | undefined, options: HandleTasksCommandOptions): string | undefined {
	if (!channel) return "已暂停：未指定投递频道";
	const described = options.describeChannel(channel);
	if (!described.boundHere) return `已暂停：投递频道未绑定到本 dot（${described.label}）`;
	return channel === options.currentChannelId ? undefined : `投递到${described.label}`;
}

function renderListLine(entry: TaskLedgerEntry, options: HandleTasksCommandOptions, now: number): string {
	const { dotDir } = options;
	const bits = [`\`${entry.id}\` ${entry.title}`, taskStateLabel(entry.fields.state)];
	const delivery = deliveryNote(entry.fields.channel, options);
	if (delivery) bits.push(delivery);
	if (entry.fields.paused) bits.push(`已暂停（${entry.fields.paused.reason}）`);
	const ticket = ticketSummary(entry, now);
	if (ticket) bits.push(ticket);
	if (entry.items) bits.push(`工作项 ${entry.items.done}/${entry.items.total}`);
	if (entry.fields.origin) bits.push(`来自 ${entry.fields.origin}`);
	const usage = usageSummary(entry);
	if (usage) bits.push(usage);
	if (hasTaskSteer(dotDir, entry.id)) bits.push("有待处理的指示");
	if (!entry.readable) bits.push("⚠️ 文件头（frontmatter）不可读");
	return `- ${bits.join(" · ")}`;
}

async function listTasks(options: HandleTasksCommandOptions): Promise<string> {
	const now = Date.now();
	const entries = (await readActiveTasks(tasksDir(options.dotDir), now)).filter((entry) => !entry.fields.outcome);
	if (entries.length === 0) {
		return "暂无进行中的任务。\n在对话里告诉我目标，并说明作为长程任务推进。";
	}
	const report = [
		`**任务（${entries.length}）**`,
		...entries.map((entry) => renderListLine(entry, options, now)),
	].join("\n");
	return capReply(report, { nextStepHint: "用 `/tasks show <id>` 查看单个任务" }).text;
}

function notFound(id: string): string {
	return `未找到任务 \`${id}\`。用 \`/tasks\` 查看进行中的任务，或 \`/tasks archive\` 查看已归档的。`;
}

/** The head of the contract, reshaped for chat and cut on a line boundary; the full file is one path away. */
function contractExcerpt(body: string, maxChars: number): { text: string; clipped: boolean } {
	const flat = flattenMarkdownForChat(body.trim());
	if (flat.length <= maxChars) return { text: flat, clipped: false };
	const cut = flat.lastIndexOf("\n", maxChars);
	const head = flat.slice(0, cut > 0 ? cut : maxChars).trimEnd();
	// A cut inside a fenced block would leave the rest of the reply rendered as code.
	const openFence = (head.match(/^```/gm)?.length ?? 0) % 2 === 1;
	return { text: openFence ? `${head}\n\`\`\`` : head, clipped: true };
}

async function showTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const { dotDir } = options;
	const id = normalizeTaskId(idInput);
	const document = (await readStoredTask(dotDir, id, true)) ?? undefined;
	if (!document) return notFound(id);
	const now = Date.now();
	const entry = (await readActiveTasks(tasksDir(dotDir), now)).find((candidate) => candidate.id === id);

	const head: string[] = [`**任务 ${id}**`];
	head.push(`- 状态：${taskStateLabel(document.fields.state)}`);
	const channel = document.fields.channel;
	if (!document.fields.outcome) {
		const note = deliveryNote(channel, options);
		head.push(
			channel
				? `- 投递频道（channel）：${options.describeChannel(channel).label}${note?.startsWith("已暂停") ? `（${note}）` : ""}`
				: `- 投递频道：未指定（${note}）`,
		);
	}
	if (document.fields.paused) {
		const by = document.fields.paused.by === "user" ? "由你暂停" : "由系统暂停";
		head.push(`- 已暂停（${by}）：${document.fields.paused.reason}`);
	}
	if (document.fields.ticket) {
		const ticket = document.fields.ticket;
		head.push(`- 等待：${describeTicketForUser(ticket)}${backstopHint(ticket.by, now)}`);
	}
	if (document.fields.origin) head.push(`- 来自事件：${document.fields.origin}`);
	const usage = entry ? usageSummary(entry) : undefined;
	if (usage) head.push(`- 用量：${usage}`);

	const board = await buildTaskBoard(dotDir, id, document.body);
	const boardLines = board ? ["", "**工作项**", renderTaskBoardForUser(board, id, now)] : [];

	const log = await readTaskLog(dotDir, id, {
		kinds: ["step", "expired", "close"],
		limit: SHOW_LOG_LINES,
	});
	const logLines = log.length > 0 ? ["", "**最近记录**", ...log.map(renderTaskLogLineForUser)] : [];

	const path = existsSync(taskPath(dotDir, id)) ? taskPath(dotDir, id) : archivedTaskPath(dotDir, id);
	const contract = contractExcerpt(document.body, TASK_SHOW_CONTRACT_CHARS);
	const report = [
		...head,
		...boardLines,
		...logLines,
		"",
		"**任务说明**",
		contract.text,
		...(contract.clipped ? ["（仅显示开头）"] : []),
		"",
		`完整记录：\`/tasks log ${id}\`；任务文件：\`${path}\``,
	].join("\n");
	return capReply(report, { nextStepHint: `用 \`/tasks log ${id}\` 查看记录，完整任务说明在 \`${path}\`` }).text;
}

const ARCHIVE_OUTCOME: Record<string, string> = { completed: "已完成", cancelled: "已取消" };

async function listArchive(dotDir: string): Promise<string> {
	const archiveDir = join(tasksDir(dotDir), "archive");
	if (!existsSync(archiveDir)) return "暂无已归档任务。\n任务完成或取消后会出现在这里。";
	const files = (await readdir(archiveDir)).filter((name) => name.endsWith(".md")).sort();
	if (files.length === 0) return "暂无已归档任务。\n任务完成或取消后会出现在这里。";
	const lines: string[] = [];
	for (const filename of files.slice(0, ARCHIVE_LIST_LIMIT)) {
		const id = filename.slice(0, -".md".length);
		const document = await readStoredTask(dotDir, id, true).catch(() => undefined);
		const outcome = document?.fields.outcome;
		const bits = [`\`${id}\``];
		if (outcome) bits.push(ARCHIVE_OUTCOME[outcome] ?? outcome);
		if (document?.fields.closedAt) bits.push(document.fields.closedAt.slice(0, 16).replace("T", " "));
		lines.push(`- ${bits.join(" · ")}`);
	}
	if (files.length > ARCHIVE_LIST_LIMIT) {
		lines.push(`- 另有 ${files.length - ARCHIVE_LIST_LIMIT} 个，在 \`${archiveDir}\``);
	}
	return capReply([`**已归档任务（${files.length}）**`, ...lines].join("\n"), {
		nextStepHint: `完整列表在 \`${archiveDir}\``,
	}).text;
}

async function showTaskLog(dotDir: string, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const all = await readTaskLog(dotDir, id);
	if (all.length === 0) return `任务 \`${id}\` 暂无记录。\n任务执行第一步后会出现在这里。`;
	const records = all.slice(-LOG_LINES);
	const path = taskLogIsArchived(dotDir, id) ? taskArchiveLogPath(dotDir, id) : taskLogPath(dotDir, id);
	const lines = [
		`**任务 ${id} 的记录（最近 ${records.length} 条，共 ${all.length} 条）**`,
		...records.map(renderTaskLogLineForUser),
	];
	if (all.length > records.length) lines.push("", `更早的记录在 \`${path}\``);
	return capReply(lines.join("\n"), { nextStepHint: `完整记录在 \`${path}\`` }).text;
}

async function pauseTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await pauseTaskDocument(options.dotDir, id, {
		by: "user",
		reason: "用户通过 /tasks pause 暂停。",
	});
	if (!document) return notFound(id);
	return `已暂停任务 \`${id}\`，等待条件已保留；需要继续时用 \`/tasks resume ${id}\`。`;
}

export async function resumeTask(
	options: HandleTasksCommandOptions,
	idInput: string,
	grants: Partial<TaskBudget> = {},
): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await resumeTaskDocument(options.dotDir, id);
	if (!document) return notFound(id);
	const granted: string[] = [];
	if (Object.keys(grants).length > 0) {
		await updateStoredTask(options.dotDir, id, (task) => {
			const budget = { ...task.fields.budget };
			for (const key of ["steps", "usd"] as const) {
				const extra = grants[key];
				if (extra === undefined) continue;
				// A grant is *additional* headroom on top of whatever the task already spent, so
				// resuming a task that hit its ceiling actually lets it run rather than re-stopping
				// on the next step.
				const spent = key === "steps" ? task.fields.usage?.steps : task.fields.usage?.usd;
				budget[key] = (spent ?? 0) + extra;
				granted.push(key === "steps" ? `${extra} 步` : `$${extra}`);
			}
			task.fields.budget = budget;
		});
	}
	return `已恢复任务 \`${id}\`${granted.length > 0 ? `，追加预算 ${granted.join("、")}` : ""}。`;
}

async function steerTask(options: HandleTasksCommandOptions, idInput: string, text: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await readStoredTask(options.dotDir, id);
	if (!document) return notFound(id);
	await queueTaskSteer(options.dotDir, id, text);
	return `已把这条指示排给任务 \`${id}\` 的下一步，不会打断正在执行的这一步。`;
}

/**
 * Answer an `ask` ticket: the reply becomes the next step's first input, and redeeming the ticket
 * is what actually reopens the task. A task parked on something else keeps its ticket — the reply
 * is still queued, because the user's words should not be dropped just because the timing was off.
 */
async function replyToTask(options: HandleTasksCommandOptions, idInput: string, text: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const document = await readStoredTask(options.dotDir, id);
	if (!document) return notFound(id);
	await queueTaskSteer(options.dotDir, id, text, "用户回答");
	const redeemed = await redeemTicket(options.dotDir, id, (ticket) => ticket.kind === "ask");
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
 * and `resolveTicket` reject those states at write time. What is left is what a *hand edit* can
 * still create.
 */
async function doctor(options: HandleTasksCommandOptions): Promise<string> {
	const now = Date.now();
	const entries = await readActiveTasks(tasksDir(options.dotDir), now);
	const problems: string[] = [];

	for (const entry of entries) {
		if (!entry.readable) {
			problems.push(
				issue(
					`\`${entry.id}\` 的文件头（frontmatter）不可读`,
					`让我修复 \`${taskPath(options.dotDir, entry.id)}\` 的文件头，或手动修改`,
				),
			);
			continue;
		}
		if (!entry.fields.channel) {
			problems.push(
				issue(
					`\`${entry.id}\` 没有投递频道（channel），已暂停`,
					`在 \`${taskPath(options.dotDir, entry.id)}\` 的文件头加一行 \`channel: <频道 ID>\``,
				),
			);
		} else if (!options.describeChannel(entry.fields.channel).boundHere) {
			problems.push(
				issue(
					`\`${entry.id}\` 的投递频道没有绑定到本 dot，已暂停`,
					"在那个频道里把它绑定回本 dot，或把文件头的 `channel:` 改成本 dot 已绑定的频道",
				),
			);
		}
		const by = entry.fields.ticket ? parseLocalTime(entry.fields.ticket.by) : undefined;
		if (entry.expired && !entry.fields.paused && by !== undefined && by < now - EXPIRED_GRACE_MS) {
			problems.push(
				issue(
					`\`${entry.id}\` 的等待条件已超过最晚检查时间 1 小时以上`,
					"自动调度本该重新开始或通知；请部署者确认服务器上的 pipiclaw 仍在运行",
				),
			);
		}
	}

	if (problems.length === 0) return `检查了 ${entries.length} 个任务，未发现问题。`;
	return capReply([`**任务体检（${problems.length} 项）**`, ...problems].join("\n"), {
		nextStepHint: "逐个修复后再运行 `/tasks doctor` 查看剩余的问题",
	}).text;
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
			return await withTaskMutation(options.dotDir, command.id, () => dispatchTasksCommand(options, command));
		}
		return await dispatchTasksCommand(options, command);
	} catch (error) {
		return `执行 /tasks ${command.action} 失败：${errorMessage(error)}`;
	}
}

async function dispatchTasksCommand(options: HandleTasksCommandOptions, command: TasksCommand): Promise<string> {
	switch (command.action) {
		case "list":
			return await listTasks(options);
		case "show":
			return await showTask(options, command.id);
		case "log":
			return await showTaskLog(options.dotDir, command.id);
		case "archive":
			return await listArchive(options.dotDir);
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
