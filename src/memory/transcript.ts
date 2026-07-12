import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { buildStandardMessages } from "../shared/type-guards.js";

// The channel runner prepends the channel capsule, recalled memory, the task agenda
// and the durable bootstrap to the raw user input, then wraps the input itself in
// <user_message>. If that combined text flows back into consolidation / session
// refresh / signal scans, previously recalled memory gets re-summarized into
// MEMORY.md — a self-reinforcing echo. Strip the injected wrappers before any memory
// job reads the transcript.
const INJECTED_CONTEXT_BLOCK =
	/<(runtime_context|runtime_turn_context|durable_memory_snapshot|task_agenda)>[\s\S]*?<\/\1>\s*/gi;
const USER_MESSAGE_WRAPPER = /^<user_message>\s*([\s\S]*?)\s*<\/user_message>$/i;

export function stripInjectedMemoryContext(text: string): string {
	const withoutBlocks = text.replace(INJECTED_CONTEXT_BLOCK, "").trim();
	const unwrapped = withoutBlocks.match(USER_MESSAGE_WRAPPER);
	return (unwrapped ? unwrapped[1] : withoutBlocks).trim();
}

function sanitizeUserMessage(message: Message & { role: "user" }): Message {
	if (typeof message.content === "string") {
		return { ...message, content: stripInjectedMemoryContext(message.content) };
	}
	return {
		...message,
		content: message.content.map((part) =>
			part.type === "text" ? { ...part, text: stripInjectedMemoryContext(part.text) } : part,
		),
	};
}

/**
 * Standard messages with runtime-injected memory context stripped from user turns.
 * Use this instead of buildStandardMessages anywhere a memory job serializes the
 * transcript, so recalled memory is never folded back into durable memory.
 */
export function sanitizeMessagesForMemory(messages: AgentMessage[]): Message[] {
	return buildStandardMessages(messages).map((message) =>
		message.role === "user" ? sanitizeUserMessage(message) : message,
	);
}
