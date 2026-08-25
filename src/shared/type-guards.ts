import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Like {@link isRecord}, but false for arrays — for parsing JSON where an array is not a valid shape. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStandardAgentMessage(message: AgentMessage): message is Message {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message.role === "user" || message.role === "assistant" || message.role === "toolResult")
	);
}

export function buildStandardMessages(messages: AgentMessage[]): Message[] {
	return messages.filter(isStandardAgentMessage);
}
