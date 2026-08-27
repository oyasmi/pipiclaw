import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { resolveEventPath } from "../runtime/event-commands.js";
import { EventValidationError, MAX_EVENT_FILES, validateScheduledEvent } from "../runtime/event-validation.js";
import { parseScheduledEventContent, type ScheduledEvent } from "../runtime/events.js";
import type { SecurityConfig } from "../security/types.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { RecoverableToolError } from "../shared/recoverable-error.js";
import { clipText, errorMessage } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";

const eventManageSchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")], {
		description: '"list" this channel\'s events, or "create" / "update" / "delete" one by name.',
	}),
	name: Type.Optional(
		Type.String({
			description:
				"Event name (filename without .json); required for create/update/delete, ignored for list. Task-owned events: `task.<channelId>.<taskId>.<use>`.",
		}),
	),
	definition: Type.Optional(
		Type.String({
			description:
				"Full event JSON (required for create/update). one-shot / periodic only; one-shots 2 minutes to about 24.8 days out. channelId defaults to the current channel.",
		}),
	),
});

export type EventManageAction = "list" | "create" | "update" | "delete";

export interface EventManageListEntry {
	name: string;
	line: string;
	parsed: boolean;
}

export interface EventManageResult {
	action: EventManageAction;
	name?: string;
	path?: string;
	eventType?: ScheduledEvent["type"];
	channelId?: string;
	bytesWritten?: number;
	deleted?: boolean;
	count?: number;
	names?: string[];
	notice: string;
}

export interface EventManageRequest {
	action: EventManageAction;
	name?: string;
	definition?: string;
}

export interface EventManageToolOptions {
	workspaceDir: string;
	channelId: string;
	commandGuardConfig: SecurityConfig["commandGuard"];
}

function parseAction(action: string): EventManageAction {
	if (action === "list" || action === "create" || action === "update" || action === "delete") {
		return action;
	}
	throw new RecoverableToolError('Unsupported event action. Use "list", "create", "update", or "delete".');
}

/** One line per event; unparseable files are listed and flagged so the model can still clean them up. */
async function listOwnedEvents(options: EventManageToolOptions): Promise<EventManageListEntry[]> {
	const dir = join(options.workspaceDir, "events");
	if (!existsSync(dir)) return [];
	const filenames = (await readdir(dir)).filter((filename) => filename.endsWith(".json")).sort();
	const entries: EventManageListEntry[] = [];
	for (const filename of filenames) {
		const name = filename.slice(0, -".json".length);
		let event: ScheduledEvent;
		try {
			event = parseScheduledEventContent(await readFile(join(dir, filename), "utf-8"), filename);
		} catch (error) {
			entries.push({ name, parsed: false, line: `- ${name} ⚠ 无法解析：${errorMessage(error)}` });
			continue;
		}
		if (event.channelId !== options.channelId) continue;
		const when = event.type === "one-shot" ? `at ${event.at}` : event.schedule;
		const pre = event.preAction ? " (preAction)" : "";
		const text = clipText(event.text, 80, { collapseWhitespace: true });
		entries.push({ name, parsed: true, line: `- ${name} [${event.type}] ${when}${pre} — ${text}` });
	}
	return entries;
}

/**
 * Validate an agent-supplied event definition and return the normalized, typed event.
 * Rejects immediate events, near-term one-shots, high-frequency periodics, guard-blocked
 * preActions, and cross-channel channelIds. The returned event is what gets persisted, so
 * the file on disk is exactly what was validated.
 *
 * The scheduling rules themselves live in `runtime/event-validation.ts` and are re-applied by
 * the watcher (spec 031, D4); this layer only adds tool-specific framing (channel ownership,
 * and turning validation failures into recoverable tool errors the model can retry).
 */
function validateDefinition(rawDefinition: string, name: string, options: EventManageToolOptions): ScheduledEvent {
	let data: unknown;
	try {
		data = JSON.parse(rawDefinition);
	} catch (error) {
		const message = errorMessage(error);
		throw new RecoverableToolError(`definition is not valid JSON: ${message}`);
	}
	if (!isRecord(data)) {
		throw new RecoverableToolError("definition must be a JSON object.");
	}

	const providedChannelId = data.channelId;
	if (providedChannelId === undefined || providedChannelId === null || providedChannelId === "") {
		data.channelId = options.channelId;
	} else if (providedChannelId !== options.channelId) {
		throw new RecoverableToolError(
			`definition channelId "${String(providedChannelId)}" does not match the current channel "${options.channelId}".`,
		);
	}

	if (data.type === "immediate") {
		throw new RecoverableToolError(
			"event_manage cannot create or update immediate events (self-triggering loop guard); " +
				"do the work in the current turn instead.",
		);
	}

	const event = parseScheduledEventContent(JSON.stringify(data), `${name}.json`);
	try {
		validateScheduledEvent(event, { commandGuardConfig: options.commandGuardConfig });
	} catch (error) {
		if (error instanceof EventValidationError && error.recoverable) {
			throw new RecoverableToolError(error.message);
		}
		throw error;
	}
	return event;
}

async function readOwnedEvent(
	eventPath: string,
	name: string,
	options: EventManageToolOptions,
): Promise<ScheduledEvent> {
	let existing: ScheduledEvent;
	try {
		existing = parseScheduledEventContent(await readFile(eventPath, "utf-8"), `${name}.json`);
	} catch (error) {
		const message = errorMessage(error);
		throw new Error(`Existing event "${name}" could not be parsed (${message}); use /events to manage it directly.`);
	}
	if (existing.channelId !== options.channelId) {
		throw new RecoverableToolError(`Event "${name}" belongs to another channel and cannot be modified from here.`);
	}
	return existing;
}

async function countEventFiles(dir: string): Promise<number> {
	if (!existsSync(dir)) return 0;
	const filenames = await readdir(dir);
	return filenames.filter((filename) => filename.endsWith(".json")).length;
}

export async function manageEvent(
	options: EventManageToolOptions,
	request: EventManageRequest,
): Promise<EventManageResult> {
	if (request.action === "list") {
		const entries = await listOwnedEvents(options);
		const notice = entries.length === 0 ? "本频道暂无定时事件。" : entries.map((entry) => entry.line).join("\n");
		return {
			action: "list",
			count: entries.length,
			names: entries.map((entry) => entry.name),
			notice,
		};
	}

	if (!request.name || request.name.trim().length === 0) {
		throw new RecoverableToolError(`${request.action} requires a non-empty event name.`);
	}
	const { eventName, eventPath } = resolveEventPath(options.workspaceDir, request.name);
	const eventsDir = join(options.workspaceDir, "events");

	if (request.action === "delete") {
		if (!existsSync(eventPath)) {
			return {
				action: "delete",
				name: eventName,
				path: eventPath,
				deleted: false,
				notice: `事件 \`${eventName}\` 不存在，无需删除。`,
			};
		}
		await readOwnedEvent(eventPath, eventName, options);
		await unlink(eventPath);
		return {
			action: "delete",
			name: eventName,
			path: eventPath,
			deleted: true,
			notice: `已删除事件 \`${eventName}\`。`,
		};
	}

	if (!request.definition || request.definition.trim().length === 0) {
		throw new RecoverableToolError(`${request.action} requires a non-empty definition.`);
	}

	if (request.action === "create") {
		if (existsSync(eventPath)) {
			throw new RecoverableToolError(`Event "${eventName}" already exists; use action "update" to replace it.`);
		}
		if ((await countEventFiles(eventsDir)) >= MAX_EVENT_FILES) {
			throw new RecoverableToolError(
				`Too many event files (>= ${MAX_EVENT_FILES}) in workspace/events; clean up stale events before creating more.`,
			);
		}
	} else {
		if (!existsSync(eventPath)) {
			throw new RecoverableToolError(`Event "${eventName}" does not exist; use action "create" to add it.`);
		}
		// Ownership check only: an existing file that no longer parses (e.g. a legacy immediate
		// event) is reported by readOwnedEvent and pointed at /events.
		await readOwnedEvent(eventPath, eventName, options);
	}

	const event = validateDefinition(request.definition, eventName, options);
	// Persist the canonical form: a tolerated legacy `timezone` is dropped so freshly written
	// events never carry the deprecated field (cron is always host-timezone now).
	if (event.type === "periodic" && event.legacyTimezone !== undefined) {
		delete event.legacyTimezone;
	}
	const content = `${JSON.stringify(event, null, 2)}\n`;
	await writeFileAtomically(eventPath, content);

	return {
		action: request.action,
		name: eventName,
		path: eventPath,
		eventType: event.type,
		channelId: event.channelId,
		bytesWritten: Buffer.byteLength(content, "utf-8"),
		notice:
			request.action === "create"
				? `已创建 ${event.type} 事件 \`${eventName}\`。`
				: `已更新 ${event.type} 事件 \`${eventName}\`。`,
	};
}

export function createEventManageTool(options: EventManageToolOptions): AgentTool<typeof eventManageSchema> {
	return {
		name: "event_manage",
		label: "event_manage",
		description:
			"List, create, update, or delete scheduled events that wake this channel later (one-shot check-ins and periodic " +
			"cadences). List to recover real event names before a reschedule or close-out. immediate events are rejected.",
		parameters: eventManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				action: string;
				name?: string;
				definition?: string;
			},
		) => {
			const result = await manageEvent(options, {
				action: parseAction(args.action),
				name: args.name,
				definition: args.definition,
			});
			const text = result.action === "list" ? result.notice : JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text }],
				details: { ...result },
			};
		},
	};
}
