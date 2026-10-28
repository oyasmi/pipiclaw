/**
 * `/tasks`: the user's control path for the desk's long-horizon tasks (list, show, log, msg, pause,
 * resume, cancel, archive, doctor). Every state change goes through the `TaskControl` port (spec 064,
 * D25); this module only parses, renders and calls it.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply, flattenMarkdownForChat } from "../commands/reply-limits.js";
import { formatElapsedZh } from "../shared/format.js";
import { parseLocalTime } from "../shared/local-time.js";
import { errorMessage } from "../shared/text-utils.js";
import { buildTaskBoard, renderTaskBoardForUser } from "./board.js";
import { normalizeTaskId, readActiveTasks, type TaskLedgerEntry } from "./contract.js";
import type { TaskControl, TaskLiveSnapshot } from "./control.js";
import { type TaskBudget, taskStateLabel } from "./frontmatter.js";
import {
	readTaskLog,
	renderTaskLogLineForUser,
	taskArchiveLogPath,
	taskLogIsArchived,
	taskLogPath,
} from "./loop-log.js";
import { archivedTaskPath, readStoredTask, taskPath } from "./store.js";

/** What `/tasks` needs to say about a delivery channel (structurally `channel/channel-id.ts`'s `ChannelDescription`). */
interface TaskChannelDescription {
	label: string;
	/** Still bound to this desk; false means the task is frozen (spec 058, D8). */
	boundHere: boolean;
}

export interface HandleTasksCommandOptions {
	args: string;
	desk: string;
	/** The desk directory; tasks live in `<deskDir>/tasks/`. */
	deskDir: string;
	/** The channel the command was typed in: a task delivering elsewhere names its channel. */
	currentChannelId: string;
	/** Who is typing, for the `message` record a `/tasks msg` writes. */
	senderName: string;
	describeChannel: (channelId: string) => TaskChannelDescription;
	control: TaskControl;
}

/** `/tasks show <id>` contract excerpt; the full file is always readable at its own path. */
const TASK_SHOW_CONTRACT_CHARS = 500;
const SHOW_LOG_LINES = 5;
/** `/tasks log <id>`: the most recent records; older ones are in the `.jsonl` it names. */
const LOG_LINES = 15;
const ARCHIVE_LIST_LIMIT = 20;
/** A work wait this old with nothing in flight means the lane is not running, not that it is about to act. */
const STALE_WORK_WAIT_MS = 60 * 60 * 1000;

type TasksCommand =
	| { action: "list" }
	| { action: "show"; id: string }
	| { action: "log"; id: string }
	| { action: "archive" }
	| { action: "doctor" }
	| { action: "pause"; id: string }
	| { action: "cancel"; id: string }
	| { action: "resume"; id: string; grants: Partial<TaskBudget> }
	| { action: "msg"; id: string; text: string };

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
	if (action === "show" || action === "pause" || action === "log" || action === "cancel") {
		const id = parts[1];
		if (!id || parts.length > 2) throw new Error(`用法：/tasks ${action} <id>`);
		return { action, id };
	}
	if (action === "resume") {
		const id = parts[1];
		if (!id) throw new Error("用法：/tasks resume <id> [+steps N|+usd X]");
		return { action: "resume", id, grants: parseGrants(parts.slice(2).join(" ")) };
	}
	if (action === "msg") {
		// Everything after the id is the message, verbatim — it is a sentence addressed to the task.
		const match = /^msg\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
		if (!match) throw new Error("用法：/tasks msg <id> <内容>");
		return { action, id: match[1], text: match[2].trim() };
	}
	throw new Error(`未知子命令 \`${action}\`。`);
}

function tasksDir(deskDir: string): string {
	return join(deskDir, "tasks");
}

function usageSummary(entry: TaskLedgerEntry): string | undefined {
	const usage = entry.fields.usage;
	if (!usage) return undefined;
	const cost = usage.usd > 0 ? ` · 花费 $${usage.usd.toFixed(2)}${usage.usdEstimated ? "（含估算）" : ""}` : "";
	return `已用 ${usage.steps} 步${cost}`;
}

/** The delivery-channel note for a task, or `undefined` when it delivers here and is live. */
function deliveryNote(channel: string | undefined, options: HandleTasksCommandOptions): string | undefined {
	if (!channel) return "已冻结：未指定汇报频道";
	const described = options.describeChannel(channel);
	if (!described.boundHere) return `已冻结：汇报频道未绑定到本工位（${described.label}）`;
	return channel === options.currentChannelId ? undefined : `汇报到${described.label}`;
}

/** The state in the user's words, with how long it has been so and what is happening right now. */
function describeLive(entry: TaskLedgerEntry, live: TaskLiveSnapshot | undefined, now: number): string {
	const label = taskStateLabel(entry.fields);
	if (entry.fields.state === "running" && live?.step) {
		const tool = live.step.tool ? `，正在${live.step.tool.summary}` : "";
		return `${label}（第 ${live.step.seq} 步，已 ${formatElapsedZh(now - live.step.startedAt)}${tool}）`;
	}
	const since = entry.fields.waiting ? parseLocalTime(entry.fields.waiting.since) : undefined;
	if (
		entry.fields.state === "waiting" &&
		entry.fields.waiting?.kind !== "time" &&
		since !== undefined &&
		now > since
	) {
		return `${label}（已等 ${formatElapsedZh(now - since)}）`;
	}
	return label;
}

function describePending(live: TaskLiveSnapshot, now: number): string[] {
	return live.pending.map((work) => {
		const who = work.kind === "delegation" ? `委派 \`${work.ref}\`（${work.label}）` : `后台作业 \`${work.ref}\``;
		const quiet =
			work.stalled && work.lastOutputAt !== undefined
				? ` · ⚠️ ${formatElapsedZh(now - work.lastOutputAt)}没有输出`
				: "";
		return `${who} 已运行 ${formatElapsedZh(now - work.startedAt)}${quiet}`;
	});
}

function renderListLine(
	entry: TaskLedgerEntry,
	live: TaskLiveSnapshot | undefined,
	options: HandleTasksCommandOptions,
	now: number,
): string {
	const bits = [`\`${entry.id}\` ${entry.title}`, describeLive(entry, live, now)];
	const delivery = deliveryNote(entry.fields.channel, options);
	if (delivery) bits.push(delivery);
	if (entry.fields.state === "waiting" && entry.fields.waiting?.kind === "user") {
		bits.push(`问题：${entry.fields.waiting.question.replace(/\s+/g, " ").slice(0, 80)}`);
	}
	if (live && live.pending.length > 0) {
		const stalled = live.pending.filter((work) => work.stalled).length;
		bits.push(`在途 ${live.pending.length} 项${stalled > 0 ? `（⚠️ ${stalled} 项疑似卡住）` : ""}`);
	}
	if (entry.items) bits.push(`工作项 ${entry.items.done}/${entry.items.total}`);
	if (entry.fields.origin) bits.push(`来自 ${entry.fields.origin}`);
	const usage = usageSummary(entry);
	if (usage) bits.push(usage);
	if (!entry.readable) bits.push("⚠️ 文件头（frontmatter）不可读");
	return `- ${bits.join(" · ")}`;
}

async function snapshotsById(options: HandleTasksCommandOptions): Promise<Map<string, TaskLiveSnapshot>> {
	const snapshots = await options.control.snapshot(options.desk).catch(() => [] as TaskLiveSnapshot[]);
	return new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
}

async function listTasks(options: HandleTasksCommandOptions): Promise<string> {
	const now = Date.now();
	const entries = (await readActiveTasks(tasksDir(options.deskDir))).filter((entry) => !entry.fields.outcome);
	if (entries.length === 0) {
		return "暂无进行中的任务。\n在对话里告诉我目标，并说明作为长程任务推进。";
	}
	const live = await snapshotsById(options);
	const report = [
		`**任务（${entries.length}）**`,
		...entries.map((entry) => renderListLine(entry, live.get(entry.id), options, now)),
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
	const { deskDir } = options;
	const id = normalizeTaskId(idInput);
	const document = (await readStoredTask(deskDir, id, true)) ?? undefined;
	if (!document) return notFound(id);
	const now = Date.now();
	const entry = (await readActiveTasks(tasksDir(deskDir))).find((candidate) => candidate.id === id);
	const live = entry ? (await options.control.snapshot(options.desk, id).catch(() => []))[0] : undefined;

	const head: string[] = [`**任务 ${id}**`];
	head.push(`- 状态：${entry ? describeLive(entry, live, now) : taskOutcomeLabel(document.fields.outcome)}`);
	if (document.fields.state === "waiting" && document.fields.waiting?.kind === "user") {
		head.push(`- 等你回复：${document.fields.waiting.question}`);
	}
	const channel = document.fields.channel;
	if (!document.fields.outcome) {
		const note = deliveryNote(channel, options);
		head.push(
			channel
				? `- 汇报频道（channel）：${options.describeChannel(channel).label}${note?.startsWith("已冻结") ? `（${note}）` : ""}`
				: `- 汇报频道：未指定（${note}）`,
		);
	}
	if (document.fields.paused) {
		const by = document.fields.paused.by === "user" ? "由你暂停" : "由系统暂停";
		head.push(`- 已暂停（${by}）：${document.fields.paused.reason}`);
	}
	if (live) for (const line of describePending(live, now)) head.push(`- 在途：${line}`);
	if (document.fields.origin) head.push(`- 来自事件：${document.fields.origin}`);
	const usage = entry ? usageSummary(entry) : undefined;
	if (usage) head.push(`- 用量：${usage}`);

	const records = await readTaskLog(deskDir, id);
	const board = buildTaskBoard(records, document.body);
	const boardLines = board ? ["", "**工作项**", renderTaskBoardForUser(board, id, now)] : [];

	const recent = records
		.filter((record) => record.kind !== "step" && record.kind !== "dispatch" && record.kind !== "stall")
		.slice(-SHOW_LOG_LINES);
	const logLines = recent.length > 0 ? ["", "**最近记录**", ...recent.map(renderTaskLogLineForUser)] : [];

	const path = existsSync(taskPath(deskDir, id)) ? taskPath(deskDir, id) : archivedTaskPath(deskDir, id);
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

function taskOutcomeLabel(outcome: string | undefined): string {
	return outcome === "completed" ? "已完成" : outcome === "cancelled" ? "已取消" : "未知";
}

const ARCHIVE_OUTCOME: Record<string, string> = { completed: "已完成", cancelled: "已取消" };

async function listArchive(deskDir: string): Promise<string> {
	const archiveDir = join(tasksDir(deskDir), "archive");
	if (!existsSync(archiveDir)) return "暂无已归档任务。\n任务完成或取消后会出现在这里。";
	const files = (await readdir(archiveDir)).filter((name) => name.endsWith(".md")).sort();
	if (files.length === 0) return "暂无已归档任务。\n任务完成或取消后会出现在这里。";
	const lines: string[] = [];
	for (const filename of files.slice(0, ARCHIVE_LIST_LIMIT)) {
		const id = filename.slice(0, -".md".length);
		const document = await readStoredTask(deskDir, id, true).catch(() => undefined);
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

async function showTaskLog(deskDir: string, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const all = await readTaskLog(deskDir, id);
	if (all.length === 0) return `任务 \`${id}\` 暂无记录。\n任务执行第一步后会出现在这里。`;
	const records = all.slice(-LOG_LINES);
	const path = taskLogIsArchived(deskDir, id) ? taskArchiveLogPath(deskDir, id) : taskLogPath(deskDir, id);
	const lines = [
		`**任务 ${id} 的记录（最近 ${records.length} 条，共 ${all.length} 条）**`,
		...records.map(renderTaskLogLineForUser),
	];
	if (all.length > records.length) lines.push("", `更早的记录在 \`${path}\``);
	return capReply(lines.join("\n"), { nextStepHint: `完整记录在 \`${path}\`` }).text;
}

async function pauseTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const outcome = await options.control.pause(options.desk, id, {
		by: "user",
		reason: "用户通过 /tasks pause 暂停。",
	});
	if (outcome.kind === "not_found") return notFound(id);
	if (outcome.kind === "unchanged") return `任务 \`${id}\` 已经是暂停状态。`;
	return `已暂停任务 \`${id}\`：当前这一步已中止，在途的委派和作业继续运行，结果会记下。继续用 \`/tasks resume ${id}\`。`;
}

async function resumeTask(
	options: HandleTasksCommandOptions,
	idInput: string,
	grants: Partial<TaskBudget>,
): Promise<string> {
	const id = normalizeTaskId(idInput);
	const outcome = await options.control.resume(options.desk, id, grants);
	if (outcome.kind === "not_found") return notFound(id);
	if (outcome.kind === "unchanged") return `任务 \`${id}\` 当前没有暂停，无需恢复。`;
	const granted: string[] = [];
	if (grants.steps) granted.push(`${grants.steps} 步`);
	if (grants.usd) granted.push(`$${grants.usd}`);
	return `已恢复任务 \`${id}\`${granted.length > 0 ? `，追加预算 ${granted.join("、")}` : ""}。`;
}

async function cancelTask(options: HandleTasksCommandOptions, idInput: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const outcome = await options.control.cancel(options.desk, id, {
		by: "user",
		note: "用户通过 /tasks cancel 取消。",
		channel: options.currentChannelId,
	});
	if (outcome.kind === "not_found") return notFound(id);
	const stopped =
		outcome.cancelled.length > 0
			? `，并取消了在途工作 ${outcome.cancelled.map((ref) => `\`${ref}\``).join("、")}`
			: "";
	return `已取消任务 \`${id}\`${stopped}。任务记录已归档，可用 \`/tasks log ${id}\` 查看。`;
}

async function messageTask(options: HandleTasksCommandOptions, idInput: string, text: string): Promise<string> {
	const id = normalizeTaskId(idInput);
	const outcome = await options.control.message(options.desk, id, {
		from: options.senderName,
		channel: options.currentChannelId,
		text,
	});
	switch (outcome.kind) {
		case "not_found":
			return notFound(id);
		case "injected":
			return `已把这条消息交给任务 \`${id}\` 正在执行的这一步。`;
		case "woke":
			return `已收到，任务 \`${id}\` 会继续推进。`;
		case "queued_for_next_step":
			return `已把这条消息排给任务 \`${id}\` 的下一步。`;
		case "held_paused":
			return `任务 \`${id}\` 已暂停：消息已记下，恢复（\`/tasks resume ${id}\`）后下一步会看到。`;
		case "held_frozen":
			return `任务 \`${id}\` 的汇报频道未绑定到本工位，任务已冻结：消息已记下，频道绑定回来后下一步会看到。`;
	}
}

function issue(problem: string, nextStep: string): string {
	return `- ${problem}（下一步：${nextStep}）`;
}

/**
 * `/tasks doctor`, deliberately small (spec 064, D25). The state machine rejects most bad states at
 * write time; what is left is what a *hand edit* can still create, and a lane that is not running.
 */
async function doctor(options: HandleTasksCommandOptions): Promise<string> {
	const now = Date.now();
	const entries = await readActiveTasks(tasksDir(options.deskDir));
	const live = await snapshotsById(options);
	const problems: string[] = [];

	for (const entry of entries) {
		if (!entry.readable) {
			problems.push(
				issue(
					`\`${entry.id}\` 的文件头（frontmatter）不可读，任务不会执行`,
					`让我修复 \`${taskPath(options.deskDir, entry.id)}\` 的文件头，或手动修改`,
				),
			);
			continue;
		}
		if (!entry.fields.channel) {
			problems.push(
				issue(
					`\`${entry.id}\` 没有汇报频道（channel），已冻结`,
					`在 \`${taskPath(options.deskDir, entry.id)}\` 的文件头加一行 \`channel: <频道 ID>\``,
				),
			);
		} else if (!options.describeChannel(entry.fields.channel).boundHere) {
			problems.push(
				issue(
					`\`${entry.id}\` 的汇报频道没有绑定到本工位，已冻结`,
					"在那个频道里把它绑定回本工位，或把文件头的 `channel:` 改成本工位已绑定的频道",
				),
			);
		}
		const waiting = entry.fields.waiting;
		const since = waiting?.kind === "work" ? parseLocalTime(waiting.since) : undefined;
		if (since !== undefined && now - since > STALE_WORK_WAIT_MS && (live.get(entry.id)?.pending.length ?? 0) === 0) {
			problems.push(
				issue(
					`\`${entry.id}\` 在等结果，但已超过 1 小时没有任何在途工作`,
					"自动调度本该重新开始；请部署者确认服务器上的 pipiclaw 仍在运行",
				),
			);
		}
	}

	if (problems.length === 0) return `检查了 ${entries.length} 个任务，未发现问题。`;
	return capReply([`**任务体检（${problems.length} 项）**`, ...problems].join("\n"), {
		nextStepHint: "逐个修复后再运行 `/tasks doctor` 查看剩余的问题",
	}).text;
}

/** Tasks holding an execution slot: a step is running or delegated work is awaited (D12). */
function isExecuting(snapshot: TaskLiveSnapshot): boolean {
	return (
		!snapshot.frozen &&
		(snapshot.state === "running" || (snapshot.state === "waiting" && snapshot.waiting?.kind === "work"))
	);
}

/** `/stop` stops the chat turn only; a line naming the executing tasks says where a task is stopped (spec 064, D27). */
export function renderStopTaskHint(snapshots: readonly TaskLiveSnapshot[]): string | undefined {
	const executing = snapshots.filter(isExecuting);
	if (executing.length === 0) return undefined;
	const ids = executing.map((snapshot) => `\`${snapshot.id}\``).join("、");
	return `本工位有任务在后台执行：${ids}。\`/stop\` 不会停它们；要暂停用 \`/tasks pause <id>\`。`;
}

/** The one `/status` line about the desk's tasks, or `undefined` when there are none (D28). */
export function renderTaskStatusLine(snapshots: readonly TaskLiveSnapshot[]): string | undefined {
	if (snapshots.length === 0) return undefined;
	const running = snapshots.filter(isExecuting).length;
	const queued = snapshots.filter((snapshot) => snapshot.state === "queued").length;
	const asking = snapshots.filter(
		(snapshot) => snapshot.state === "waiting" && snapshot.waiting?.kind === "user",
	).length;
	return `- 后台任务：执行中 ${running} · 排队 ${queued} · 等你回复 ${asking}`;
}

export async function handleTasksCommand(options: HandleTasksCommandOptions): Promise<string> {
	let command: TasksCommand;
	try {
		command = parseTasksCommand(options.args);
	} catch (error) {
		return `${errorMessage(error)}\n\n${usage()}`;
	}

	try {
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
			return await showTaskLog(options.deskDir, command.id);
		case "archive":
			return await listArchive(options.deskDir);
		case "pause":
			return await pauseTask(options, command.id);
		case "resume":
			return await resumeTask(options, command.id, command.grants);
		case "cancel":
			return await cancelTask(options, command.id);
		case "msg":
			return await messageTask(options, command.id, command.text);
		case "doctor":
			return await doctor(options);
	}
}
