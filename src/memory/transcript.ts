import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { buildStandardMessages } from "../shared/type-guards.js";
import { redactSecrets } from "./secret-redaction.js";

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
		return { ...message, content: redactSecrets(stripInjectedMemoryContext(message.content)) };
	}
	return {
		...message,
		content: message.content.map((part) =>
			part.type === "text" ? { ...part, text: redactSecrets(stripInjectedMemoryContext(part.text)) } : part,
		),
	};
}

function sanitizeAssistantMessage(message: Message & { role: "assistant" }): Message {
	return {
		...message,
		content: message.content.map((part) => {
			if (part.type === "text") {
				return { ...part, text: redactSecrets(part.text) };
			}
			if (part.type === "thinking") {
				return { ...part, thinking: redactSecrets(part.thinking) };
			}
			return part;
		}),
	};
}

/**
 * Standard messages with runtime-injected memory context stripped from user turns.
 * Use this instead of buildStandardMessages anywhere a memory job serializes the
 * transcript, so recalled memory is never folded back into durable memory.
 */
export function sanitizeMessagesForMemory(messages: AgentMessage[]): Message[] {
	return buildStandardMessages(messages)
		.filter((message) => message.role !== "toolResult")
		.map((message) => {
			if (message.role === "user") return sanitizeUserMessage(message);
			if (message.role === "assistant") return sanitizeAssistantMessage(message);
			return message;
		});
}

/** The displayable text of one user/assistant `Message`, or `""` for a role with no text content. */
export function messageText(message: Message): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

/**
 * True once the transcript contains a real back-and-forth — at least one user turn and one
 * assistant turn that both carry non-empty text — rather than just a one-sided ping or a run of
 * tool-only turns. This is the single bar for "worth running memory consolidation on"; it used to
 * be answered two different ways in two different maintenance paths, which could reach opposite
 * conclusions on the same short, hand-authored transcript.
 */
export function hasMeaningfulExchange(messages: Message[]): boolean {
	let userSeen = false;
	let assistantSeen = false;
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		if (!messageText(message).trim()) continue;
		if (message.role === "user") userSeen = true;
		if (message.role === "assistant") assistantSeen = true;
		if (userSeen && assistantSeen) return true;
	}
	return false;
}
