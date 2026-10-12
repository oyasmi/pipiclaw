/**
 * Parsing a scheduled-event definition file into a `ScheduledEvent`: the payload (text or task
 * template), the optional pre-action gate and the schedule. Pure — the watcher owns reading files.
 */
import { errorMessage } from "../shared/text-utils.js";
import { isPlainObject } from "../shared/type-guards.js";
import { validateTaskContractInput } from "../tasks/contract-input.js";
import type { EventAction, EventPayload, ScheduledEvent } from "./types.js";
import { EventDefinitionError } from "./validation.js";

/** The one-line description of what an event delivers, for history records and listings. */
export function describeEventPayload(event: Pick<ScheduledEvent, "text" | "task">): string {
	return event.task ? `任务模板：${event.task.title}` : (event.text ?? "");
}

function readRequiredString(data: Record<string, unknown>, field: string, filename: string): string {
	const value = data[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new EventDefinitionError(
			"missing-field",
			`Missing required fields (type, channelId, and text or task) in ${filename}`,
		);
	}
	return value;
}

/** `text` xor `task`: a chat message, or a template for a task instance (spec 052, D2). */
function parsePayload(data: Record<string, unknown>, filename: string): EventPayload {
	const hasText = typeof data.text === "string" && data.text.trim().length > 0;
	const hasTask = data.task !== undefined;
	if (hasText === hasTask) {
		throw new EventDefinitionError(
			"payload",
			`An event needs exactly one of 'text' (a chat message) or 'task' (a task template) in ${filename}`,
		);
	}
	if (hasText) return { text: data.text as string };
	try {
		return { task: validateTaskContractInput(data.task) };
	} catch (error) {
		throw new EventDefinitionError("task-template", `Invalid 'task' template in ${filename}: ${errorMessage(error)}`);
	}
}

function parsePreAction(data: Record<string, unknown>, filename: string): EventAction | undefined {
	if (!data.preAction) return undefined;
	if (!isPlainObject(data.preAction)) {
		throw new EventDefinitionError("pre-action", `Invalid 'preAction' field in ${filename}, expected an object`);
	}

	const action = data.preAction;
	if (action.type !== "bash") {
		throw new EventDefinitionError(
			"pre-action",
			`Unsupported preAction type '${String(action.type)}' in ${filename}, only 'bash' is supported`,
		);
	}
	if (typeof action.command !== "string" || action.command.trim().length === 0) {
		throw new EventDefinitionError("pre-action", `Missing or empty 'preAction.command' in ${filename}`);
	}
	if (action.timeout !== undefined) {
		if (typeof action.timeout !== "number" || !Number.isFinite(action.timeout) || action.timeout <= 0) {
			throw new EventDefinitionError(
				"pre-action",
				`Invalid 'preAction.timeout' in ${filename}, expected a positive millisecond value`,
			);
		}
	}

	return {
		type: "bash",
		command: action.command,
		...(typeof action.timeout === "number" ? { timeout: action.timeout } : {}),
	};
}

export function parseScheduledEventContent(content: string, filename: string): ScheduledEvent {
	let data: unknown;
	try {
		data = JSON.parse(content);
	} catch (error) {
		throw new EventDefinitionError("malformed", `Invalid JSON in ${filename}: ${errorMessage(error)}`);
	}
	if (!isPlainObject(data)) {
		throw new EventDefinitionError(
			"missing-field",
			`Missing required fields (type, channelId, and text or task) in ${filename}`,
		);
	}

	const type = readRequiredString(data, "type", filename);
	const channelId = readRequiredString(data, "channelId", filename);
	const payload = parsePayload(data, filename);
	const preAction = parsePreAction(data, filename);

	switch (type) {
		// Removed in spec 031 (D4): an event that fires the moment it is written is a
		// self-triggering loop with no gate in front of it, and nothing in the runtime produced
		// one. Rejecting it here — rather than only in `event_manage` — is what makes the guard
		// enforced, since the events directory is agent-writable.
		case "immediate":
			throw new EventDefinitionError(
				"immediate",
				`Immediate events are no longer supported (${filename}); do the work in the current turn, ` +
					"or schedule a one-shot at least 2 minutes out via event_manage.",
			);

		case "one-shot": {
			if (typeof data.at !== "string" || data.at.trim().length === 0) {
				throw new EventDefinitionError("missing-field", `Missing 'at' field for one-shot event in ${filename}`);
			}
			return { type, channelId, ...payload, at: data.at, ...(preAction ? { preAction } : {}) };
		}

		case "periodic": {
			if (typeof data.schedule !== "string" || data.schedule.trim().length === 0) {
				throw new EventDefinitionError(
					"missing-field",
					`Missing 'schedule' field for periodic event in ${filename}`,
				);
			}
			return {
				type,
				channelId,
				...payload,
				schedule: data.schedule,
				...(preAction ? { preAction } : {}),
			};
		}

		default:
			throw new EventDefinitionError("unknown-type", `Unknown event type '${type}' in ${filename}`);
	}
}

/**
 * Stable, provenance-derived dispatch id (spec 031, D1).
 *
 * The identity of a wake is its *occurrence*, never the moment it happened to be executed.
 * A one-shot keyed on its own `at` therefore lands on the same durable record whether it
 * arrives via the outbox retry or via the post-restart file recovery path, so the two
 * independent retry systems can no longer deliver the same occurrence twice. A live periodic
 * occurrence is keyed on Croner's callback start time, so its durable outbox retries collapse
 * while the next callback produces a genuinely new record.
 */
