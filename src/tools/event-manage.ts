import { existsSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Cron } from "croner";
import { Type } from "typebox";
import { resolveEventPath } from "../runtime/event-commands.js";
import { parseScheduledEventContent, type ScheduledEvent } from "../runtime/events.js";
import { guardCommand } from "../security/command-guard.js";
import type { SecurityConfig } from "../security/types.js";
import { writeFileAtomically } from "../shared/atomic-file.js";
import { isRecord } from "../shared/type-guards.js";

/** one-shot events must be scheduled at least this far out; anything sooner is effectively self-triggering. */
const MIN_ONE_SHOT_LEAD_MS = 2 * 60 * 1000;
/** periodic events without a preAction gate may fire no more often than this. */
const MIN_PERIODIC_INTERVAL_MS = 30 * 60 * 1000;
/**
 * periodic events WITH a preAction gate may fire this often: the sensor is the token guard
 * (it exits non-zero and stays silent when there is nothing to do), so a tighter cadence is
 * safe and is exactly the design-endorsed posture for completion-driven checks (e.g. polling
 * an agentmux instance until it goes idle). A hard sub-floor still applies so a bogus
 * always-pass preAction cannot drive an arbitrarily hot loop.
 */
const MIN_PERIODIC_INTERVAL_WITH_PREACTION_MS = 5 * 60 * 1000;
/** sanity cap on total event files to keep the directory (and the scheduler) from being flooded. */
const MAX_EVENT_FILES = 50;

const eventManageSchema = Type.Object({
	label: Type.String({ description: "Brief description of the scheduling change (shown to the user)" }),
	action: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")], {
		description: 'The event management action to perform: "create", "update", or "delete".',
	}),
	name: Type.String({
		description:
			"Event name (filename without .json). For task-owned events use `task.<channelId>.<taskId>.<use>`, e.g. `task.dm_123.weekly-report.checkin`.",
	}),
	definition: Type.Optional(
		Type.String({
			description:
				"Full event JSON (required for create/update). one-shot / periodic only; immediate is rejected. channelId defaults to the current channel.",
		}),
	),
});

export type EventManageAction = "create" | "update" | "delete";

export interface EventManageResult {
	action: EventManageAction;
	name: string;
	path: string;
	eventType?: ScheduledEvent["type"];
	channelId?: string;
	bytesWritten?: number;
	deleted?: boolean;
	notice: string;
}

export interface EventManageRequest {
	action: EventManageAction;
	name: string;
	definition?: string;
}

export interface EventManageToolOptions {
	workspaceDir: string;
	workspacePath: string;
	channelId: string;
	commandGuardConfig: SecurityConfig["commandGuard"];
}

function parseAction(action: string): EventManageAction {
	if (action === "create" || action === "update" || action === "delete") {
		return action;
	}
	throw new Error('Unsupported event action. Use "create", "update", or "delete".');
}

function toWorkspacePath(options: EventManageToolOptions, hostPath: string): string {
	if (hostPath.startsWith(options.workspaceDir)) {
		return `${options.workspacePath}${hostPath.slice(options.workspaceDir.length)}`;
	}
	return hostPath;
}

function validateTimezone(timezone: string): void {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone: timezone });
	} catch {
		throw new Error(`Invalid timezone: ${timezone}`);
	}
}

function validateOneShot(event: ScheduledEvent & { type: "one-shot" }): void {
	const atTime = new Date(event.at).getTime();
	if (!Number.isFinite(atTime)) {
		throw new Error(`one-shot 'at' is not a valid date: ${event.at}`);
	}
	if (atTime < Date.now() + MIN_ONE_SHOT_LEAD_MS) {
		throw new Error("one-shot 'at' must be at least 2 minutes in the future (self-triggering guard).");
	}
}

function validatePeriodic(event: ScheduledEvent & { type: "periodic" }): void {
	validateTimezone(event.timezone);
	let runs: Date[];
	try {
		const cron = new Cron(event.schedule, { timezone: event.timezone });
		runs = cron.nextRuns(3);
		cron.stop();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid cron schedule "${event.schedule}": ${message}`);
	}
	// A preAction gate makes a tighter cadence safe (the sensor keeps most fires silent);
	// without one, hold the 30-minute floor so a bare high-frequency cron can't burn tokens.
	const floorMs = event.preAction ? MIN_PERIODIC_INTERVAL_WITH_PREACTION_MS : MIN_PERIODIC_INTERVAL_MS;
	const floorMinutes = Math.round(floorMs / 60000);
	// Fewer than two upcoming runs means no meaningful cadence to rate-limit (e.g. a one-off cron); allow it.
	for (let i = 1; i < runs.length; i++) {
		if (runs[i].getTime() - runs[i - 1].getTime() < floorMs) {
			throw new Error(
				`periodic events must fire no more often than every ${floorMinutes} minutes` +
					`${event.preAction ? " (even with a preAction gate)" : "; for tighter checks add a preAction gate (min 5 minutes) instead of a high-frequency cron"}.`,
			);
		}
	}
}

function validatePreAction(event: ScheduledEvent, commandGuardConfig: SecurityConfig["commandGuard"]): void {
	if (!event.preAction) return;
	const result = guardCommand(event.preAction.command, commandGuardConfig);
	if (!result.allowed) {
		throw new Error(`preAction command blocked by guard: ${result.reason ?? "not allowed"}`);
	}
}

/**
 * Validate an agent-supplied event definition and return the normalized, typed event.
 * Rejects immediate events, near-term one-shots, high-frequency periodics, guard-blocked
 * preActions, and cross-channel channelIds. The returned event is what gets persisted, so
 * the file on disk is exactly what was validated.
 */
function validateDefinition(rawDefinition: string, name: string, options: EventManageToolOptions): ScheduledEvent {
	let data: unknown;
	try {
		data = JSON.parse(rawDefinition);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`definition is not valid JSON: ${message}`);
	}
	if (!isRecord(data)) {
		throw new Error("definition must be a JSON object.");
	}

	const providedChannelId = data.channelId;
	if (providedChannelId === undefined || providedChannelId === null || providedChannelId === "") {
		data.channelId = options.channelId;
	} else if (providedChannelId !== options.channelId) {
		throw new Error(
			`definition channelId "${String(providedChannelId)}" does not match the current channel "${options.channelId}".`,
		);
	}

	const event = parseScheduledEventContent(JSON.stringify(data), `${name}.json`);

	if (event.type === "immediate") {
		throw new Error(
			"event_manage cannot create or update immediate events (self-triggering loop guard); " +
				"do the work in the current turn instead.",
		);
	}
	if (event.type === "one-shot") {
		validateOneShot(event);
	}
	if (event.type === "periodic") {
		validatePeriodic(event);
	}
	validatePreAction(event, options.commandGuardConfig);
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
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Existing event "${name}" could not be parsed (${message}); use /events to manage it directly.`);
	}
	if (existing.channelId !== options.channelId) {
		throw new Error(`Event "${name}" belongs to another channel and cannot be modified from here.`);
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
	const { eventName, eventPath } = resolveEventPath(options.workspaceDir, request.name);
	const eventsDir = join(options.workspaceDir, "events");

	if (request.action === "delete") {
		if (!existsSync(eventPath)) {
			return {
				action: "delete",
				name: eventName,
				path: toWorkspacePath(options, eventPath),
				deleted: false,
				notice: `事件 \`${eventName}\` 不存在，无需删除。`,
			};
		}
		await readOwnedEvent(eventPath, eventName, options);
		await unlink(eventPath);
		return {
			action: "delete",
			name: eventName,
			path: toWorkspacePath(options, eventPath),
			deleted: true,
			notice: `已删除事件 \`${eventName}\`。`,
		};
	}

	if (!request.definition || request.definition.trim().length === 0) {
		throw new Error(`${request.action} requires a non-empty definition.`);
	}

	if (request.action === "create") {
		if (existsSync(eventPath)) {
			throw new Error(`Event "${eventName}" already exists; use action "update" to replace it.`);
		}
		if ((await countEventFiles(eventsDir)) >= MAX_EVENT_FILES) {
			throw new Error(
				`Too many event files (>= ${MAX_EVENT_FILES}) in workspace/events; clean up stale events before creating more.`,
			);
		}
	} else {
		if (!existsSync(eventPath)) {
			throw new Error(`Event "${eventName}" does not exist; use action "create" to add it.`);
		}
		const existing = await readOwnedEvent(eventPath, eventName, options);
		if (existing.type === "immediate") {
			throw new Error(`Event "${eventName}" is an immediate event and cannot be updated via event_manage.`);
		}
	}

	const event = validateDefinition(request.definition, eventName, options);
	const content = `${JSON.stringify(event, null, 2)}\n`;
	await writeFileAtomically(eventPath, content);

	return {
		action: request.action,
		name: eventName,
		path: toWorkspacePath(options, eventPath),
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
			"Create, update, or delete scheduled events (one-shot check-ins and periodic cadences) that wake this " +
			"channel later. Use for task self-scheduling: arrange a follow-up after delegating, reschedule while " +
			"blocked, clean up on close. immediate events are rejected; do that work in the current turn.",
		parameters: eventManageSchema,
		execute: async (
			_toolCallId: string,
			args: {
				label: string;
				action: string;
				name: string;
				definition?: string;
			},
		) => {
			const result = await manageEvent(options, {
				action: parseAction(args.action),
				name: args.name,
				definition: args.definition,
			});
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: {
					kind: "event_manage",
					...result,
				},
			};
		},
	};
}
