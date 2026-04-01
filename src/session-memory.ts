import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import { serializeConversation } from "@mariozechner/pi-coding-agent";
import { writeFile } from "fs/promises";
import { join } from "path";
import { parseJsonObject } from "./llm-json.js";
import { splitLevelOneSections } from "./markdown-sections.js";
import { readChannelMemory } from "./memory-files.js";
import { readChannelSession, rewriteChannelSession } from "./session-memory-files.js";
import { runSidecarTask, SidecarParseError } from "./sidecar-worker.js";

const SESSION_TRANSCRIPT_MAX_CHARS = 20_000;
const SESSION_MEMORY_MAX_CHARS = 4_000;
const SESSION_ITEM_LIMIT = 12;
const SESSION_ITEM_MAX_CHARS = 300;
const DEFAULT_SESSION_MEMORY_TIMEOUT_MS = 30_000;

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
	timeoutMs?: number;
}

type SessionMemoryStateUpdate = Partial<Record<keyof SessionMemoryState, string[] | string>>;

function clipText(text: string, maxChars: number): string {
	const normalized = text.replace(/\r/g, "").trim();
	if (normalized.length <= maxChars) {
		return normalized;
	}
	const headChars = Math.floor(maxChars * 0.45);
	const tailChars = maxChars - headChars;
	return `${normalized.slice(0, headChars)}\n\n[... omitted middle section ...]\n\n${normalized.slice(-tailChars)}`;
}

function normalizeItem(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return null;
	}
	return normalized.length > SESSION_ITEM_MAX_CHARS
		? `${normalized.slice(0, SESSION_ITEM_MAX_CHARS - 3)}...`
		: normalized;
}

function normalizeItems(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map(normalizeItem)
		.filter((item): item is string => !!item)
		.slice(0, SESSION_ITEM_LIMIT);
}

function normalizeTitle(value: unknown): string {
	return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseStateUpdate(text: string): SessionMemoryStateUpdate {
	const parsed = parseJsonObject(text);
	if (!isRecord(parsed)) {
		throw new Error("Session memory response was not a JSON object");
	}

	const next: SessionMemoryStateUpdate = {};
	if ("title" in parsed) next.title = normalizeTitle(parsed.title);
	if ("currentState" in parsed) next.currentState = normalizeItems(parsed.currentState);
	if ("userIntent" in parsed) next.userIntent = normalizeItems(parsed.userIntent);
	if ("activeFiles" in parsed) next.activeFiles = normalizeItems(parsed.activeFiles);
	if ("decisions" in parsed) next.decisions = normalizeItems(parsed.decisions);
	if ("constraints" in parsed) next.constraints = normalizeItems(parsed.constraints);
	if ("errorsAndCorrections" in parsed) next.errorsAndCorrections = normalizeItems(parsed.errorsAndCorrections);
	if ("nextSteps" in parsed) next.nextSteps = normalizeItems(parsed.nextSteps);
	if ("worklog" in parsed) next.worklog = normalizeItems(parsed.worklog);
	return next;
}

function createEmptySessionMemoryState(): SessionMemoryState {
	return {
		title: "",
		currentState: [],
		userIntent: [],
		activeFiles: [],
		decisions: [],
		constraints: [],
		errorsAndCorrections: [],
		nextSteps: [],
		worklog: [],
	};
}

function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function parseSectionItems(content: string): string[] {
	const normalized = stripHtmlComments(content);
	if (!normalized) {
		return [];
	}

	const lines = normalized
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const bulletItems = lines
		.filter((line) => line.startsWith("- "))
		.map((line) => normalizeItem(line.slice(2)))
		.filter((item): item is string => !!item);
	if (bulletItems.length > 0) {
		return bulletItems.slice(0, SESSION_ITEM_LIMIT);
	}
	return lines
		.map(normalizeItem)
		.filter((item): item is string => !!item)
		.slice(0, SESSION_ITEM_LIMIT);
}

function parseRenderedSessionMemory(markdown: string): SessionMemoryState {
	const state = createEmptySessionMemoryState();
	for (const section of splitLevelOneSections(markdown)) {
		switch (section.heading.toLowerCase()) {
			case "session title":
				state.title = stripHtmlComments(section.content).split("\n")[0]?.trim().slice(0, 120) || "";
				break;
			case "current state":
				state.currentState = parseSectionItems(section.content);
				break;
			case "user intent":
				state.userIntent = parseSectionItems(section.content);
				break;
			case "active files":
				state.activeFiles = parseSectionItems(section.content);
				break;
			case "decisions":
				state.decisions = parseSectionItems(section.content);
				break;
			case "constraints":
				state.constraints = parseSectionItems(section.content);
				break;
			case "errors & corrections":
				state.errorsAndCorrections = parseSectionItems(section.content);
				break;
			case "next steps":
				state.nextSteps = parseSectionItems(section.content);
				break;
			case "worklog":
				state.worklog = parseSectionItems(section.content);
				break;
		}
	}
	return state;
}

function mergeSessionMemoryState(current: SessionMemoryState, update: SessionMemoryStateUpdate): SessionMemoryState {
	return {
		title: typeof update.title === "string" ? update.title : current.title,
		currentState: Array.isArray(update.currentState) ? update.currentState : current.currentState,
		userIntent: Array.isArray(update.userIntent) ? update.userIntent : current.userIntent,
		activeFiles: Array.isArray(update.activeFiles) ? update.activeFiles : current.activeFiles,
		decisions: Array.isArray(update.decisions) ? update.decisions : current.decisions,
		constraints: Array.isArray(update.constraints) ? update.constraints : current.constraints,
		errorsAndCorrections: Array.isArray(update.errorsAndCorrections)
			? update.errorsAndCorrections
			: current.errorsAndCorrections,
		nextSteps: Array.isArray(update.nextSteps) ? update.nextSteps : current.nextSteps,
		worklog: Array.isArray(update.worklog) ? update.worklog : current.worklog,
	};
}

async function writeSessionMemoryDebugFile(channelDir: string, error: unknown, rawText: string): Promise<void> {
	const debugPath = join(channelDir, "SESSION.invalid-response.txt");
	const header = [
		`timestamp: ${new Date().toISOString()}`,
		`error: ${error instanceof Error ? error.message : String(error)}`,
		"",
		"raw response:",
		"",
	].join("\n");
	await writeFile(debugPath, `${header}${rawText}\n`, "utf-8");
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

export async function updateChannelSessionMemory(options: SessionMemoryUpdateOptions): Promise<SessionMemoryState> {
	const currentSession = await readChannelSession(options.channelDir);
	const currentMemory = await readChannelMemory(options.channelDir);
	const messages = buildMessagesForSessionMemory(options.messages);
	const currentState = parseRenderedSessionMemory(currentSession);

	let update: SessionMemoryStateUpdate;
	try {
		const result = await runSidecarTask({
			name: "session-memory-update",
			model: options.model,
			resolveApiKey: options.resolveApiKey,
			systemPrompt: SESSION_MEMORY_SYSTEM_PROMPT,
			prompt: buildSessionPrompt(currentSession, currentMemory, messages),
			parse: parseStateUpdate,
			timeoutMs: options.timeoutMs ?? DEFAULT_SESSION_MEMORY_TIMEOUT_MS,
		});
		update = result.output;
	} catch (error) {
		if (error instanceof SidecarParseError) {
			await writeSessionMemoryDebugFile(options.channelDir, error.cause ?? error, error.rawText);
		}
		throw error;
	}

	const rendered = renderSessionMemory(mergeSessionMemoryState(currentState, update));
	await rewriteChannelSession(options.channelDir, rendered);
	return parseRenderedSessionMemory(rendered);
}
