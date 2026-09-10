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

const eventDefinitionSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("one-shot"), Type.Literal("periodic"), Type.Literal("immediate")], {
			description: '"one-shot" (needs `at`), "periodic" (needs cron `schedule`). "immediate" is always rejected.',
		}),
		text: Type.String({ description: "Message delivered to the channel when the event fires." }),
		at: Type.Optional(
			Type.String({ description: "one-shot local time, e.g. 2026-07-27T07:30:00+08:00 (2 min to ~24.8 days out)." }),
		),
		schedule: Type.Optional(Type.String({ description: "periodic 5-field cron, in the host timezone." })),
		preAction: Type.Optional(
			Type.Object(
				{
					type: Type.Literal("bash"),
					command: Type.String({
						description: "Command run just before delivery; exit 0 = fire, non-zero = skip.",
					}),
					timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in milliseconds (not s)." })),
				},
				{ description: "Optional gate/sensor command." },
			),
		),
	},
	{ description: "The event to create/update. Channel is bound automatically — do not pass channelId." },
);

const eventManageSchema = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("show"),
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("delete"),
		],
		{
			description:
				'"list" this channel\'s events, "show" one event\'s full definition (for a safe update), or "create" / "update" / "delete" one by name.',
		},
	),
	name: Type.Optional(
		Type.String({
			description:
				"Event name (filename without .json); required for show/create/update/delete, ignored for list. Task-owned events: `task.<channelId>.<taskId>.<use>`.",
		}),
	),
	definition: Type.Optional(eventDefinitionSchema),
});

export type EventManageAction = "list" | "show" | "create" | "update" | "delete";
export type EventDefinitionInput = {
	type: "one-shot" | "periodic" | "immediate";
	text: string;
	at?: string;
	schedule?: string;
	preAction?: { type: "bash"; command: string; timeoutMs?: number };
};

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
	definition?: EventDefinitionInput;
}

export interface EventManageToolOptions {
	workspaceDir: string;
	channelId: string;
	commandGuardConfig: SecurityConfig["commandGuard"];
}

function parseAction(action: string): EventManageAction {
	if (action === "list" || action === "show" || action === "create" || action === "update" || action === "delete") {
		return action;
	}
	throw new RecoverableToolError('Unsupported event action. Use "list", "show", "create", "update", or "delete".');
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
function validateDefinition(
	definition: EventDefinitionInput,
	name: string,
	options: EventManageToolOptions,
): ScheduledEvent {
	if (definition.type === "immediate") {
		throw new RecoverableToolError(
			"event_manage cannot create or update immediate events (self-triggering loop guard); " +
				"do the work in the current turn instead.",
		);
	}
	if (definition.type === "one-shot" && !definition.at?.trim()) {
		throw new RecoverableToolError('A one-shot event needs "at" (a local time 2 minutes to ~24.8 days out).');
	}
	if (definition.type === "periodic" && !definition.schedule?.trim()) {
		throw new RecoverableToolError('A periodic event needs "schedule" (a 5-field cron expression).');
	}

	// Assemble the on-disk shape. `channelId` is bound here, never taken from the model; the
	// preAction timeout field is `timeout` (ms) on disk but `timeoutMs` in the schema so the unit
	// is unambiguous (fix plan §3.6).
	const onDisk: Record<string, unknown> = {
		type: definition.type,
		channelId: options.channelId,
		text: definition.text,
		...(definition.type === "one-shot" ? { at: definition.at } : { schedule: definition.schedule }),
		...(definition.preAction
			? {
					preAction: {
						type: "bash",
						command: definition.preAction.command,
						...(definition.preAction.timeoutMs !== undefined ? { timeout: definition.preAction.timeoutMs } : {}),
					},
				}
			: {}),
	};

	// Both the parse and the schedule validation become recoverable: a missing/malformed field is
	// something the model can fix itself, and `parseScheduledEventContent` used to throw a plain
	// Error that bypassed the recoverable wrapper (fix plan §3.6).
	let event: ScheduledEvent;
	try {
		event = parseScheduledEventContent(JSON.stringify(onDisk), `${name}.json`);
	} catch (error) {
		throw new RecoverableToolError(`Invalid event definition: ${errorMessage(error)}`);
	}
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

	if (request.action === "show") {
		if (!existsSync(eventPath)) {
			throw new RecoverableToolError(`Event "${eventName}" does not exist. Use action "list" to see what's here.`);
		}
		const existing = await readOwnedEvent(eventPath, eventName, options);
		return {
			action: "show",
			name: eventName,
			path: eventPath,
			eventType: existing.type,
			channelId: existing.channelId,
			notice: JSON.stringify(existing, null, 2),
		};
	}

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

	if (!request.definition || !request.definition.type || !request.definition.text?.trim()) {
		throw new RecoverableToolError(`${request.action} requires a definition with at least "type" and "text".`);
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
			"List, show, create, update, or delete scheduled events that wake this channel later (one-shot check-ins and " +
			"periodic cadences). Use list to recover event names, and show to read an event's full definition before an " +
			"update. immediate events are rejected.",
		parameters: eventManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				action: string;
				name?: string;
				definition?: EventDefinitionInput;
			},
		) => {
			const result = await manageEvent(options, {
				action: parseAction(args.action),
				name: args.name,
				definition: args.definition,
			});
			const text =
				result.action === "list" || result.action === "show" ? result.notice : JSON.stringify(result, null, 2);
			return {
				content: [{ type: "text", text }],
				details: { ...result },
			};
		},
	};
}
