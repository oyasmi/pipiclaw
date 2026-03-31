import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@mariozechner/pi-ai";
import { serializeConversation } from "@mariozechner/pi-coding-agent";
import { readChannelMemory } from "./memory-files.js";
import { readChannelSession, rewriteChannelSession } from "./session-memory-files.js";
import { runSidecarTask } from "./sidecar-worker.js";

const SESSION_TRANSCRIPT_MAX_CHARS = 20_000;
const SESSION_MEMORY_MAX_CHARS = 4_000;
const SESSION_ITEM_LIMIT = 12;
const SESSION_ITEM_MAX_CHARS = 300;

const SESSION_MEMORY_SYSTEM_PROMPT = `You maintain a Pipiclaw SESSION.md file.

Return strict JSON only. Do not use Markdown fences.

Output schema:
{
  "title": "string",
  "currentState": ["string"],
  "userIntent": ["string"],
  "activeFiles": ["string"],
  "decisions": ["string"],
  "constraints": ["string"],
  "errorsAndCorrections": ["string"],
  "nextSteps": ["string"],
  "worklog": ["string"]
}

Rules:
- Prefer short, information-dense bullet-sized items.
- Capture only the current active work state, not the full conversation history.
- Keep durable facts out unless they are directly relevant to the current work.
- "activeFiles" should list only files, directories, or work areas currently in focus.
- "errorsAndCorrections" should record recent failures, fixes, or things to avoid repeating.
- "nextSteps" should reflect the most likely immediate follow-up actions.
- "worklog" must stay terse and recent.
- If a field has nothing useful, return an empty string or empty array.`;

export interface SessionMemoryState {
	title: string;
	currentState: string[];
	userIntent: string[];
	activeFiles: string[];
	decisions: string[];
	constraints: string[];
	errorsAndCorrections: string[];
	nextSteps: string[];
	worklog: string[];
}

export interface SessionMemoryUpdateOptions {
	channelDir: string;
	messages: AgentMessage[];
	model: Model<Api>;
	resolveApiKey: (model: Model<Api>) => Promise<string>;
}

function clipText(text: string, maxChars: number): string {
	const normalized = text.replace(/\r/g, "").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	const headChars = Math.floor(maxChars * 0.45);
	const tailChars = maxChars - headChars;
	return `${normalized.slice(0, headChars)}\n\n[... omitted middle section ...]\n\n${normalized.slice(-tailChars)}`;
}

function extractJsonObject(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
		return trimmed;
	}

	const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenceMatch?.[1]) {
		return fenceMatch[1].trim();
	}

	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return trimmed.slice(firstBrace, lastBrace + 1);
	}

	return trimmed;
}

function normalizeItem(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return null;
	}
	return normalized.length > SESSION_ITEM_MAX_CHARS ? `${normalized.slice(0, SESSION_ITEM_MAX_CHARS - 3)}...` : normalized;
}

function normalizeItems(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map(normalizeItem).filter((item): item is string => !!item).slice(0, SESSION_ITEM_LIMIT);
}

function parseState(text: string): SessionMemoryState {
	const parsed = JSON.parse(extractJsonObject(text)) as Partial<Record<keyof SessionMemoryState, unknown>>;
	const title = typeof parsed.title === "string" ? parsed.title.trim().slice(0, 120) : "";

	return {
		title,
		currentState: normalizeItems(parsed.currentState),
		userIntent: normalizeItems(parsed.userIntent),
		activeFiles: normalizeItems(parsed.activeFiles),
		decisions: normalizeItems(parsed.decisions),
		constraints: normalizeItems(parsed.constraints),
		errorsAndCorrections: normalizeItems(parsed.errorsAndCorrections),
		nextSteps: normalizeItems(parsed.nextSteps),
		worklog: normalizeItems(parsed.worklog),
	};
}

function renderSection(heading: string, items: string[]): string {
	return [`# ${heading}`, "", ...items.map((item) => `- ${item}`)].join("\n");
}

function isStandardAgentMessage(message: AgentMessage): message is Message {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message.role === "user" || message.role === "assistant" || message.role === "toolResult")
	);
}

function buildMessagesForSessionMemory(messages: AgentMessage[]): Message[] {
	return messages.filter(isStandardAgentMessage);
}

export function renderSessionMemory(state: SessionMemoryState): string {
	const sections: string[] = [];
	if (state.title.trim()) {
		sections.push("# Session Title", "", state.title.trim());
	}

	const orderedSections: Array<[string, string[]]> = [
		["Current State", state.currentState],
		["User Intent", state.userIntent],
		["Active Files", state.activeFiles],
		["Decisions", state.decisions],
		["Constraints", state.constraints],
		["Errors & Corrections", state.errorsAndCorrections],
		["Next Steps", state.nextSteps],
		["Worklog", state.worklog],
	];

	for (const [heading, items] of orderedSections) {
		if (items.length === 0 && heading === "Worklog") {
			continue;
		}
		sections.push(renderSection(heading, items));
	}

	return `${sections.join("\n\n").trim()}\n`;
}

function buildSessionPrompt(currentSession: string, currentMemory: string, messages: Message[]): string {
	const transcript = clipText(serializeConversation(messages), SESSION_TRANSCRIPT_MAX_CHARS);
	return `Current SESSION.md:
${currentSession || "(empty)"}

Current channel MEMORY.md:
${clipText(currentMemory, SESSION_MEMORY_MAX_CHARS) || "(empty)"}

Recent conversation:
${transcript || "(empty)"}`;
}

export async function updateChannelSessionMemory(
	options: SessionMemoryUpdateOptions,
): Promise<SessionMemoryState> {
	const currentSession = await readChannelSession(options.channelDir);
	const currentMemory = await readChannelMemory(options.channelDir);
	const messages = buildMessagesForSessionMemory(options.messages);

	const result = await runSidecarTask({
		name: "session-memory-update",
		model: options.model,
		resolveApiKey: options.resolveApiKey,
		systemPrompt: SESSION_MEMORY_SYSTEM_PROMPT,
		prompt: buildSessionPrompt(currentSession, currentMemory, messages),
		parse: parseState,
	});

	const rendered = renderSessionMemory(result.output);
	await rewriteChannelSession(options.channelDir, rendered);
	return result.output;
}
