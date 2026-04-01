import { COMMAND_RESULT_CUSTOM_TYPE } from "../command-extension.js";
import { isRecord } from "../shared/type-guards.js";
import type { SubAgentToolDetails } from "../subagents/tool.js";
import type {
	AssistantContentPart,
	AssistantEventMessage,
	AssistantUsageMessage,
	AutoCompactionEndEvent,
	AutoCompactionStartEvent,
	AutoRetryStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	SessionEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
} from "./types.js";

function isMessageWithRole(value: unknown): value is { role: string } {
	return isRecord(value) && typeof value.role === "string";
}

export function isAssistantEventMessage(value: unknown): value is AssistantEventMessage {
	return isMessageWithRole(value) && value.role === "assistant" && Array.isArray((value as { content?: unknown }).content);
}

export function isAssistantUsageMessage(value: unknown): value is AssistantUsageMessage {
	if (!isMessageWithRole(value) || value.role !== "assistant" || !("usage" in value) || !isRecord(value.usage)) {
		return false;
	}
	return (
		typeof value.usage.input === "number" &&
		typeof value.usage.output === "number" &&
		typeof value.usage.cacheRead === "number" &&
		typeof value.usage.cacheWrite === "number" &&
		isRecord(value.usage.cost) &&
		typeof value.usage.cost.input === "number" &&
		typeof value.usage.cost.output === "number" &&
		typeof value.usage.cost.cacheRead === "number" &&
		typeof value.usage.cost.cacheWrite === "number" &&
		typeof value.usage.cost.total === "number"
	);
}

export function getLastAssistantUsage(messages: readonly unknown[]): AssistantUsageMessage | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isAssistantUsageMessage(message) && message.stopReason !== "aborted") {
			return message;
		}
	}

	return null;
}

export function isThinkingPart(part: AssistantContentPart): part is Extract<AssistantContentPart, { type: "thinking" }> {
	return part.type === "thinking" && typeof (part as { thinking?: unknown }).thinking === "string";
}

export function isTextPart(part: AssistantContentPart): part is Extract<AssistantContentPart, { type: "text" }> {
	return part.type === "text" && typeof (part as { text?: unknown }).text === "string";
}

function hasEventType(
	value: unknown,
	type: SessionEvent["type"],
): value is { type: SessionEvent["type"] } & Record<string, unknown> {
	return isRecord(value) && value.type === type;
}

export function isToolExecutionStartEvent(value: unknown): value is ToolExecutionStartEvent {
	return hasEventType(value, "tool_execution_start") && typeof value.toolCallId === "string" && typeof value.toolName === "string";
}

export function isToolExecutionUpdateEvent(value: unknown): value is ToolExecutionUpdateEvent {
	return hasEventType(value, "tool_execution_update") && typeof value.toolCallId === "string" && typeof value.toolName === "string";
}

export function isToolExecutionEndEvent(value: unknown): value is ToolExecutionEndEvent {
	return (
		hasEventType(value, "tool_execution_end") &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		typeof value.isError === "boolean"
	);
}

export function isMessageStartEvent(value: unknown): value is MessageStartEvent {
	return hasEventType(value, "message_start") && "message" in value;
}

export function isMessageEndEvent(value: unknown): value is MessageEndEvent {
	return hasEventType(value, "message_end") && "message" in value;
}

export function isTurnEndEvent(value: unknown): value is TurnEndEvent {
	return hasEventType(value, "turn_end") && "message" in value && Array.isArray(value.toolResults);
}

export function isAutoCompactionStartEvent(value: unknown): value is AutoCompactionStartEvent {
	return hasEventType(value, "auto_compaction_start") && (value.reason === "threshold" || value.reason === "overflow");
}

export function isAutoCompactionEndEvent(value: unknown): value is AutoCompactionEndEvent {
	return hasEventType(value, "auto_compaction_end");
}

export function isAutoRetryStartEvent(value: unknown): value is AutoRetryStartEvent {
	return (
		hasEventType(value, "auto_retry_start") &&
		typeof value.attempt === "number" &&
		typeof value.maxAttempts === "number" &&
		typeof value.errorMessage === "string"
	);
}

export function isSubAgentToolDetails(value: unknown): value is SubAgentToolDetails {
	if (!value || typeof value !== "object" || !("kind" in value) || (value as { kind?: unknown }).kind !== "subagent") {
		return false;
	}

	if (!("usage" in value)) {
		return false;
	}

	const usage = (value as { usage?: unknown }).usage;
	return (
		!!usage &&
		typeof usage === "object" &&
		"input" in usage &&
		"output" in usage &&
		"cacheRead" in usage &&
		"cacheWrite" in usage &&
		"cost" in usage
	);
}

export function extractCustomCommandResultText(message: unknown): string | null {
	if (
		!message ||
		typeof message !== "object" ||
		!("role" in message) ||
		!("customType" in message) ||
		(message as { role?: unknown }).role !== "custom" ||
		(message as { customType?: unknown }).customType !== COMMAND_RESULT_CUSTOM_TYPE
	) {
		return null;
	}

	const content = (message as { content?: unknown }).content;
	return typeof content === "string" && content.trim() ? content : null;
}
