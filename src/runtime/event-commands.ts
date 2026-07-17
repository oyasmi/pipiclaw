import { existsSync } from "fs";
import { readdir, readFile, unlink } from "fs/promises";
import { join, resolve, sep } from "path";
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
	return `# Events

Usage:

- \`/events list\`
- \`/events show <name>\`
- \`/events delete <name>\`
- \`/events history [name]\``;
}

function parseEventsCommand(args: string): EventsCommand {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0];
	const name = parts[1];

	if (!action || action === "list") {
		if (parts.length > 1) throw new Error("Usage: /events list");
		return { action: "list" };
	}

	if (action === "show") {
		if (!name || parts.length > 2) throw new Error("Usage: /events show <name>");
		return { action, name };
	}

	if (action === "delete") {
		if (!name || parts.length > 2) throw new Error("Usage: /events delete <name>");
		return { action, name };
	}

	if (action === "history") {
		if (parts.length > 2) throw new Error("Usage: /events history [name]");
		return name ? { action, name } : { action };
	}

	throw new Error(`Unknown /events action: ${action}`);
}

function eventsDir(workspaceDir: string): string {
	return join(workspaceDir, "events");
}

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
	const lines = [`- ${name}`, `  type: ${event.type}`, `  channelId: ${event.channelId}`];
	if (event.type === "one-shot") {
		lines.push(`  at: ${event.at}`);
	}
	if (event.type === "periodic") {
		lines.push(`  schedule: ${event.schedule}`);
	}
	lines.push(`  text: ${clipText(event.text)}`);
	return lines.join("\n");
}

async function listEvents(workspaceDir: string): Promise<string> {
	const dir = eventsDir(workspaceDir);
	if (!existsSync(dir)) {
		return "# Events\n\nNo events directory found.";
	}

	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".json")).sort();
	if (filenames.length === 0) {
		return "# Events\n\nNo event files found.";
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
			blocks.push(`- ${name}\n  invalid: ${message}`);
		}
	}

	return `# Events\n\n${blocks.join("\n\n")}`;
}

async function showEvent(workspaceDir: string, name: string): Promise<string> {
	const { eventName, eventPath } = resolveEventPath(workspaceDir, name);
	if (!existsSync(eventPath)) {
		return `Event not found: ${eventName}`;
	}

	const raw = await readFile(eventPath, "utf-8");
	const parsed = JSON.parse(raw);
	return `# Event: ${eventName}

\`\`\`json
${JSON.stringify(parsed, null, 2)}
\`\`\``;
}

async function deleteEvent(workspaceDir: string, name: string): Promise<string> {
	const { eventName, eventPath } = resolveEventPath(workspaceDir, name);
	if (!existsSync(eventPath)) {
		return `Event not found: ${eventName}`;
	}

	await unlink(eventPath);
	return `Deleted event: ${eventName}`;
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
	if (record.channelId) details.push(`  channelId: ${record.channelId}`);
	if (record.schedule) details.push(`  schedule: ${record.schedule}`);
	if (record.at) details.push(`  at: ${record.at}`);
	if (record.nextRunAt) details.push(`  nextRunAt: ${record.nextRunAt}`);
	if (record.reason) details.push(`  reason: ${record.reason}`);
	if (record.textPreview) details.push(`  text: ${clipText(record.textPreview)}`);
	const header = `- ${record.ts} ${record.eventName} ${record.action} ${record.result}`;
	return details.length > 0 ? `${header}\n${details.join("\n")}` : header;
}

async function showHistory(historyPath: string, name?: string): Promise<string> {
	const eventName = name ? normalizeEventName(name) : undefined;
	if (!existsSync(historyPath)) {
		return "# Event History\n\nNo event history found.";
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
		return eventName
			? `# Event History\n\nNo history found for event: ${eventName}`
			: "# Event History\n\nNo history found.";
	}

	const suffix = eventName ? `: ${eventName}` : "";
	return `# Event History${suffix}\n\n${records.map(formatHistoryRecord).join("\n\n")}`;
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
		return `Could not ${command.action} events: ${message}`;
	}
}
