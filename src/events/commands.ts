/**
 * `/events`: list, show, delete and history of one desk's scheduled events, confined to
 * `<desk>/events/` and that desk's slice of the event history (spec 058, D14).
 */
import { existsSync } from "fs";
import { readdir, readFile, unlink } from "fs/promises";
import { join } from "path";
import type { ChannelDescription } from "../channel/channel-id.js";
import { renderSubcommandUsage } from "../commands/catalog.js";
import { capReply } from "../commands/reply-limits.js";
import { normalizeSafeId, resolveSafeIdPath } from "../shared/safe-id.js";
import { errorMessage, eventNameFromFilename, clipText as sharedClipText } from "../shared/text-utils.js";
import { describeEventPayload, parseScheduledEventContent } from "./parse.js";
import type { EventHistoryRecord, ScheduledEvent } from "./types.js";
import { EventDefinitionError, type EventProblemKind, validateScheduledEvent } from "./validation.js";

const EVENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEFAULT_HISTORY_LIMIT = 20;
const TEXT_PREVIEW_MAX_CHARS = 100;

export interface HandleEventsCommandOptions {
	args: string;
	/** The asking channel's desk: its `events/` and its history records are the whole scope. */
	desk: string;
	deskDir: string;
	historyPath: string;
	/** Names a delivery channel and says whether it is still bound to this desk. */
	describeChannel: (channelId: string) => ChannelDescription;
}

type EventsCommand =
	| { action: "list" }
	| { action: "show"; name: string }
	| { action: "delete"; name: string }
	| { action: "history"; name?: string };

function usage(): string {
	return renderSubcommandUsage("events");
}

/** Exported so `test/commands-subcommands.test.ts` can feed every broadcast example back through it. */
export function parseEventsCommand(args: string): EventsCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0];
	const name = parts[1];

	if (!action || action === "list") {
		if (parts.length > 1) throw new Error("用法：/events list");
		return { action: "list" };
	}

	if (action === "show") {
		if (!name || parts.length > 2) throw new Error("用法：/events show <name>");
		return { action, name };
	}

	if (action === "delete") {
		if (!name || parts.length > 2) throw new Error("用法：/events delete <name>");
		return { action, name };
	}

	if (action === "history") {
		if (parts.length > 2) throw new Error("用法：/events history [name]");
		return name ? { action, name } : { action };
	}

	throw new Error(`未知子命令 \`${action}\`。`);
}

function eventsDir(deskDir: string): string {
	return join(deskDir, "events");
}

const SAFE_ID_OPTIONS = { suffix: ".json", pattern: EVENT_NAME_PATTERN, label: "event name" };

// English on purpose: shared with the model-facing `event_manage` tool (src/tools/event-manage.ts),
// which follows the tool-error convention elsewhere in the codebase, not the command-reply one.
export function normalizeEventName(name: string): string {
	return normalizeSafeId(name, SAFE_ID_OPTIONS);
}

export function resolveEventPath(deskDir: string, name: string): { eventName: string; eventPath: string } {
	const { id: eventName, path: eventPath } = resolveSafeIdPath(eventsDir(deskDir), name, SAFE_ID_OPTIONS);
	return { eventName, eventPath };
}

function clipText(text: string, maxChars = TEXT_PREVIEW_MAX_CHARS): string {
	return sharedClipText(text, maxChars, { headRatio: 1, omitHint: "...", collapseWhitespace: true });
}

function formatEventSummary(
	name: string,
	event: ScheduledEvent,
	describeChannel: HandleEventsCommandOptions["describeChannel"],
): string {
	const channel = describeChannel(event.channelId);
	const lines = [
		`**${name}**`,
		`- 类型：${event.type}`,
		`- 投递频道（channelId）：${channel.label}${channel.boundHere ? "" : "（已暂停：投递频道未绑定到本工位）"}`,
	];
	if (event.type === "one-shot") {
		lines.push(`- 触发时间：${event.at}`);
	}
	if (event.type === "periodic") {
		lines.push(`- 时间表（schedule）：${event.schedule}`);
	}
	lines.push(`- 内容：${clipText(describeEventPayload(event))}`);
	return lines.join("\n");
}

/**
 * Why a definition is invalid, in the user's terms (spec 053, D2). The error's own message is
 * English text for the model (`event_manage`), so it is never pasted here.
 */
const PROBLEM_TEXT: Record<EventProblemKind, string> = {
	malformed: "文件不是有效的 JSON",
	"missing-field": "缺少必填字段（type、channelId、at 或 schedule，以及 text 或 task 之一）",
	payload: "text 和 task 必须恰好填一个",
	"task-template": "task 模板无效",
	"pre-action": "preAction 配置无效",
	immediate: "不再支持 immediate 类型",
	"unknown-type": "未知的事件类型",
	"one-shot-time": "at 不是有效的时间",
	"one-shot-too-soon": "at 距现在不足 2 分钟",
	"one-shot-too-far": "at 超过约 24.8 天，更远的时间请改用 periodic",
	"cron-invalid": "schedule 不是有效的 cron 表达式",
	"cadence-too-frequent": "触发过于频繁（没有 preAction 时至少间隔 30 分钟，有 preAction 时至少 5 分钟）",
	"pre-action-blocked": "preAction 命令被安全策略拦截",
};

function describeEventProblem(error: unknown, name: string): string {
	if (error instanceof EventDefinitionError) return PROBLEM_TEXT[error.kind];
	return `定义无效，用 \`/events show ${name}\` 查看`;
}

const EMPTY_EVENTS = "暂无定时事件。\n在对话里告诉我要定时做什么，我会创建事件。";

async function listEvents(options: HandleEventsCommandOptions): Promise<string> {
	const dir = eventsDir(options.deskDir);
	if (!existsSync(dir)) return EMPTY_EVENTS;

	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".json")).sort();
	if (filenames.length === 0) return EMPTY_EVENTS;

	const blocks: string[] = [];
	for (const filename of filenames) {
		const eventPath = join(dir, filename);
		const name = eventNameFromFilename(filename);
		try {
			const event = parseScheduledEventContent(await readFile(eventPath, "utf-8"), filename);
			// The same definition rules the watcher applies, so "listed as fine" means "will run".
			// The lead-time rule is creation-only (an overdue one-shot is a legitimate recovery).
			validateScheduledEvent(event, { enforceOneShotLead: false });
			blocks.push(formatEventSummary(name, event, options.describeChannel));
		} catch (error) {
			blocks.push(`**${name}**\n- ⚠️ 无效：${describeEventProblem(error, name)}`);
		}
	}

	return capReply(`**定时事件**\n\n${blocks.join("\n\n")}`, {
		nextStepHint: "用 `/events show <name>` 查看单个事件",
	}).text;
}

function eventNotFound(eventName: string): string {
	return `未找到事件 \`${eventName}\`。用 \`/events list\` 查看。`;
}

async function showEvent(options: HandleEventsCommandOptions, name: string): Promise<string> {
	const { eventName, eventPath } = resolveEventPath(options.deskDir, name);
	if (!existsSync(eventPath)) return eventNotFound(eventName);

	const raw = await readFile(eventPath, "utf-8");
	let body: string;
	try {
		body = JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		// Show the bytes as they are: an unparseable file is exactly the case the user needs to see.
		body = raw;
	}
	let status = "";
	try {
		const channel = options.describeChannel(parseScheduledEventContent(raw, `${eventName}.json`).channelId);
		status = `- 投递频道：${channel.label}${channel.boundHere ? "" : "（已暂停：投递频道未绑定到本工位）"}\n\n`;
	} catch {
		// An unparseable file has no channel to describe; the raw body below says why.
	}
	return capReply(`**事件 ${eventName}**\n\n${status}\`\`\`json\n${body}\n\`\`\``, {
		nextStepHint: `完整文件在 \`${eventPath}\``,
	}).text;
}

async function deleteEvent(options: HandleEventsCommandOptions, name: string): Promise<string> {
	const { eventName, eventPath } = resolveEventPath(options.deskDir, name);
	if (!existsSync(eventPath)) return eventNotFound(eventName);

	// Read before deleting so the reply carries what was removed (review 2026-08-24 §3.4):
	// an accidental delete stays recoverable from chat history instead of a bare confirmation.
	let summary: string | undefined;
	try {
		const event = parseScheduledEventContent(await readFile(eventPath, "utf-8"), `${eventName}.json`);
		summary = formatEventSummary(eventName, event, options.describeChannel);
	} catch {
		// Unparseable content is still safe to delete; just skip the summary.
	}

	await unlink(eventPath);
	return summary ? `已删除事件：\n\n${summary}` : `已删除事件 \`${eventName}\`。`;
}

function parseHistoryLine(line: string): EventHistoryRecord | null {
	try {
		const parsed = JSON.parse(line) as Partial<EventHistoryRecord>;
		if (typeof parsed.ts !== "string" || typeof parsed.eventName !== "string") {
			return null;
		}
		return parsed as EventHistoryRecord;
	} catch {
		return null;
	}
}

const HISTORY_ACTION: Record<string, string> = {
	loaded: "已加载",
	scheduled: "已排程",
	triggered: "已触发",
	skipped: "已跳过",
	enqueued: "已送达频道",
	queue_full: "频道队列已满",
	deleted: "已删除",
	invalid: "无效",
	pre_action_started: "preAction 开始",
	pre_action_passed: "preAction 通过",
	pre_action_blocked: "preAction 未通过",
	pre_action_failed: "preAction 出错",
	cancelled: "已取消",
};

const HISTORY_RESULT: Record<string, string> = { ok: "成功", error: "失败", skipped: "跳过" };

/** `2026-10-11T14:02:33.000+08:00` → `10-11 14:02`. */
function minuteStamp(ts: string): string {
	const match = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(ts);
	return match ? `${match[1]} ${match[2]}` : ts;
}

/** One flat bullet per record; the operator detail (`reason`) is quoted as-is, it is a log entry. */
function formatHistoryRecord(record: EventHistoryRecord): string {
	const action = HISTORY_ACTION[record.action] ?? record.action;
	const result = HISTORY_RESULT[record.result] ?? record.result;
	const bits = [`${minuteStamp(record.ts)} ${record.eventName}`, `${action}（${result}）`];
	if (record.nextRunAt) bits.push(`下次 ${minuteStamp(record.nextRunAt)}`);
	if (record.reason) bits.push(`详情：\`${clipText(record.reason.replace(/`/g, "'"))}\``);
	return `- ${bits.join(" · ")}`;
}

function belongsToDesk(record: EventHistoryRecord, options: HandleEventsCommandOptions): boolean {
	return record.desk === options.desk;
}

async function showHistory(options: HandleEventsCommandOptions, name?: string): Promise<string> {
	const { historyPath } = options;
	const eventName = name ? normalizeEventName(name) : undefined;
	const empty = eventName
		? `暂无事件 \`${eventName}\` 的触发记录。\n事件触发后会记录在这里。`
		: "暂无事件触发记录。\n事件触发后会记录在这里。";
	if (!existsSync(historyPath)) return empty;

	const raw = await readFile(historyPath, "utf-8");
	const records = raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map(parseHistoryLine)
		.filter((record): record is EventHistoryRecord => !!record)
		.filter((record) => belongsToDesk(record, options))
		.filter((record) => !eventName || record.eventName === eventName)
		.slice(-DEFAULT_HISTORY_LIMIT)
		.reverse();

	if (records.length === 0) return empty;

	const suffix = eventName ? ` · ${eventName}` : "";
	return capReply(
		`**事件历史**${suffix}（最近 ${records.length} 条）\n\n${records.map(formatHistoryRecord).join("\n")}`,
		{
			nextStepHint: `用 \`/events history <name>\` 只看一个事件；完整记录在 \`${historyPath}\``,
		},
	).text;
}

export async function handleEventsCommand(options: HandleEventsCommandOptions): Promise<string> {
	let command: EventsCommand;
	try {
		command = parseEventsCommand(options.args);
	} catch (error) {
		const message = errorMessage(error);
		return `${message}\n\n${usage()}`;
	}

	try {
		switch (command.action) {
			case "list":
				return await listEvents(options);
			case "show":
				return await showEvent(options, command.name);
			case "delete":
				return await deleteEvent(options, command.name);
			case "history":
				return await showHistory(options, command.name);
		}
	} catch (error) {
		const message = errorMessage(error);
		return `执行 /events ${command.action} 失败：${message}`;
	}
}
