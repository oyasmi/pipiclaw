import { existsSync } from "fs";
import { readdir, readFile, unlink } from "fs/promises";
import { join, resolve, sep } from "path";
import { renderSubcommandUsage } from "../agent/commands.js";
import { capReply } from "../agent/reply-limits.js";
import { errorMessage, eventNameFromFilename } from "../shared/text-utils.js";
import { type EventHistoryRecord, parseScheduledEventContent, type ScheduledEvent } from "./events.js";

const EVENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEFAULT_HISTORY_LIMIT = 20;
const TEXT_PREVIEW_MAX_CHARS = 100;

export interface HandleEventsCommandOptions {
	args: string;
	workspaceDir: string;
	historyPath: string;
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

	throw new Error(`未知的 /events 动作：${action}`);
}

function eventsDir(workspaceDir: string): string {
	return join(workspaceDir, "events");
}

// English on purpose: shared with the model-facing `event_manage` tool (src/tools/event-manage.ts),
// which follows the tool-error convention elsewhere in the codebase, not the command-reply one.
export function normalizeEventName(name: string): string {
	const trimmed = name.trim();
	const normalized = trimmed.endsWith(".json") ? trimmed.slice(0, -".json".length) : trimmed;
	if (!normalized || normalized === "." || normalized === ".." || !EVENT_NAME_PATTERN.test(normalized)) {
		throw new Error(`Invalid event name: ${name}`);
	}
	return normalized;
}

export function resolveEventPath(workspaceDir: string, name: string): { eventName: string; eventPath: string } {
	const eventName = normalizeEventName(name);
	const dir = resolve(eventsDir(workspaceDir));
	const eventPath = resolve(dir, `${eventName}.json`);
	if (eventPath !== join(dir, `${eventName}.json`) || !eventPath.startsWith(`${dir}${sep}`)) {
		throw new Error(`Invalid event name: ${name}`);
	}
	return { eventName, eventPath };
}

function clipText(text: string, maxChars = TEXT_PREVIEW_MAX_CHARS): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}...` : normalized;
}

function formatEventSummary(name: string, event: ScheduledEvent): string {
	const lines = [`**${name}**`, `- 类型：${event.type}`, `- channelId：${event.channelId}`];
	if (event.type === "one-shot") {
		lines.push(`- 触发时间：${event.at}`);
	}
	if (event.type === "periodic") {
		lines.push(`- schedule：${event.schedule}`);
	}
	lines.push(`- 内容：${clipText(event.text)}`);
	return lines.join("\n");
}

async function listEvents(workspaceDir: string): Promise<string> {
	const dir = eventsDir(workspaceDir);
	if (!existsSync(dir)) {
		return "**定时事件**\n\n没有找到 events 目录。";
	}

	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".json")).sort();
	if (filenames.length === 0) {
		return "**定时事件**\n\n暂无事件文件。";
	}

	const blocks: string[] = [];
	for (const filename of filenames) {
		const eventPath = join(dir, filename);
		const name = eventNameFromFilename(filename);
		try {
			const event = parseScheduledEventContent(await readFile(eventPath, "utf-8"), filename);
			blocks.push(formatEventSummary(name, event));
		} catch (error) {
			const message = errorMessage(error);
			blocks.push(`**${name}**\n- ⚠ 无效：${message}`);
		}
	}

	return capReply(`**定时事件**\n\n${blocks.join("\n\n")}`, {
		nextStepHint: "用 `/events show <name>` 查看单个事件",
	}).text;
}

async function showEvent(workspaceDir: string, name: string): Promise<string> {
	const { eventName, eventPath } = resolveEventPath(workspaceDir, name);
	if (!existsSync(eventPath)) {
		return `找不到事件：${eventName}`;
	}

	const raw = await readFile(eventPath, "utf-8");
	const parsed = JSON.parse(raw);
	return `**事件 ${eventName}**

\`\`\`json
${JSON.stringify(parsed, null, 2)}
\`\`\``;
}

async function deleteEvent(workspaceDir: string, name: string): Promise<string> {
	const { eventName, eventPath } = resolveEventPath(workspaceDir, name);
	if (!existsSync(eventPath)) {
		return `找不到事件：${eventName}`;
	}

	// Read before deleting so the reply carries what was removed (review 2026-08-24 §3.4):
	// an accidental delete stays recoverable from chat history instead of a bare confirmation.
	let summary: string | undefined;
	try {
		const event = parseScheduledEventContent(await readFile(eventPath, "utf-8"), `${eventName}.json`);
		summary = formatEventSummary(eventName, event);
	} catch {
		// Unparseable content is still safe to delete; just skip the summary.
	}

	await unlink(eventPath);
	return summary ? `已删除事件：\n\n${summary}` : `已删除事件：${eventName}`;
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

function formatHistoryRecord(record: EventHistoryRecord): string {
	const details: string[] = [];
	if (record.channelId) details.push(`- channelId：${record.channelId}`);
	if (record.schedule) details.push(`- schedule：${record.schedule}`);
	if (record.at) details.push(`- 触发时间：${record.at}`);
	if (record.nextRunAt) details.push(`- 下次运行：${record.nextRunAt}`);
	if (record.reason) details.push(`- 原因：${record.reason}`);
	if (record.textPreview) details.push(`- 内容：${clipText(record.textPreview)}`);
	const header = `**${record.ts} ${record.eventName}** ${record.action} · ${record.result}`;
	return details.length > 0 ? `${header}\n${details.join("\n")}` : header;
}

async function showHistory(historyPath: string, name?: string): Promise<string> {
	const eventName = name ? normalizeEventName(name) : undefined;
	if (!existsSync(historyPath)) {
		return "**事件历史**\n\n暂无事件历史。";
	}

	const raw = await readFile(historyPath, "utf-8");
	const records = raw
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map(parseHistoryLine)
		.filter((record): record is EventHistoryRecord => !!record)
		.filter((record) => !eventName || record.eventName === eventName)
		.slice(-DEFAULT_HISTORY_LIMIT)
		.reverse();

	if (records.length === 0) {
		return eventName ? `**事件历史**\n\n未找到事件 ${eventName} 的历史。` : "**事件历史**\n\n暂无事件历史。";
	}

	const suffix = eventName ? ` · ${eventName}` : "";
	return `**事件历史**${suffix}\n\n${records.map(formatHistoryRecord).join("\n\n")}`;
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
				return await listEvents(options.workspaceDir);
			case "show":
				return await showEvent(options.workspaceDir, command.name);
			case "delete":
				return await deleteEvent(options.workspaceDir, command.name);
			case "history":
				return await showHistory(options.historyPath, command.name);
		}
	} catch (error) {
		const message = errorMessage(error);
		return `执行 /events ${command.action} 失败：${message}`;
	}
}
