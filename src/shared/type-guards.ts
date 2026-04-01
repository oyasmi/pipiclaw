import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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
