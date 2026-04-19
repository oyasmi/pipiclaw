import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { clipText } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";

export type SessionSearchSource = "context" | "session" | "log";
export type SessionSearchRole = "user" | "assistant" | "tool" | "system" | "unknown";

export interface SessionSearchDocument {
	id: string;
	source: SessionSearchSource;
	path: string;
	timestamp?: string;
	role: SessionSearchRole;
	text: string;
	sessionId?: string;
}

export interface BuildSessionCorpusOptions {
	channelDir: string;
	maxFiles: number;
	maxCharsPerDocument?: number;
	maxDocumentsTotal?: number;
}

const DEFAULT_MAX_CHARS_PER_DOCUMENT = 4_000;
const DEFAULT_MAX_DOCUMENTS_TOTAL = 5_000;
const IGNORED_JSONL_FILES = new Set([
	"context.jsonl",
	"log.jsonl",
	"log.jsonl.1",
	"subagent-runs.jsonl",
	"memory-review.jsonl",
]);

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

async function readOptionalFile(path: string): Promise<string> {
	try {
		return await readFile(path, "utf-8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return "";
		}
		throw error;
	}
}

function parseJsonLine(line: string): unknown | null {
	const trimmed = line.trim();
	if (!trimmed) {
		return null;
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return null;
	}
}

function normalizeRole(value: unknown): SessionSearchRole {
	if (value === "user" || value === "assistant" || value === "tool" || value === "system") {
		return value;
	}
	if (value === "bot") {
		return "assistant";
	}
	return "unknown";
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((part) => {
			if (!isRecord(part)) {
				return "";
			}
			if (part.type === "text" && typeof part.text === "string") {
				return part.text;
			}
			if (part.type === "thinking" && typeof part.thinking === "string") {
				return part.thinking;
			}
			if (part.type === "toolCall") {
				const toolName =
					(typeof part.toolName === "string" && part.toolName) ||
					(typeof part.name === "string" && part.name) ||
					"unknown";
				return `[tool call: ${toolName}]`;
			}
			if (part.type === "image") {
				return "[image]";
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractMessageText(message: unknown): { role: SessionSearchRole; text: string } {
	if (!isRecord(message)) {
		return { role: "unknown", text: "" };
	}
	return {
		role: normalizeRole(message.role),
		text: extractContentText(message.content),
	};
}

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return isRecord(value) ? value : null;
}

function createDocument(params: {
	id: string;
	source: SessionSearchSource;
	path: string;
	timestamp?: string;
	role: SessionSearchRole;
	text: string;
	sessionId?: string;
	maxChars: number;
}): SessionSearchDocument | null {
	const text = clipText(params.text, params.maxChars, { headRatio: 0.55, omitHint: "\n[...]\n" }).trim();
	if (!text) {
		return null;
	}
	return {
		id: params.id,
		source: params.source,
		path: params.path,
		timestamp: params.timestamp,
		role: params.role,
		text,
		sessionId: params.sessionId,
	};
}

function parseSessionEntry(
	value: unknown,
	path: string,
	lineNumber: number,
	source: SessionSearchSource,
	maxChars: number,
): SessionSearchDocument | null {
	if (!isRecord(value)) {
		return null;
	}

	const timestamp = getStringField(value, "timestamp") ?? getStringField(value, "date");
	const sessionId = getStringField(value, "sessionId") ?? getStringField(value, "branchId");

	if (value.type === "message") {
		const message = getNestedRecord(value, "message");
		if (!message) {
			return null;
		}
		const { role, text } = extractMessageText(message);
		return createDocument({
			id: `${basename(path)}:${lineNumber}`,
			source,
			path,
			timestamp,
			role,
			text,
			sessionId,
			maxChars,
		});
	}

	if ("message" in value && isRecord(value.message)) {
		const { role, text } = extractMessageText(value.message);
		return createDocument({
			id: `${basename(path)}:${lineNumber}`,
			source,
			path,
			timestamp,
			role,
			text,
			sessionId,
			maxChars,
		});
	}

	const role = normalizeRole(value.role);
	const text = getStringField(value, "text") ?? getStringField(value, "content") ?? "";
	return createDocument({
		id: `${basename(path)}:${lineNumber}`,
		source,
		path,
		timestamp,
		role,
		text,
		sessionId,
		maxChars,
	});
}

function parseLogEntry(
	value: unknown,
	path: string,
	lineNumber: number,
	maxChars: number,
): SessionSearchDocument | null {
	if (!isRecord(value)) {
		return null;
	}

	const isBot = value.isBot === true;
	const text = getStringField(value, "text") ?? "";
	const role = isBot ? "assistant" : "user";
	const timestamp = getStringField(value, "date") ?? getStringField(value, "ts");
	const userName = getStringField(value, "displayName") ?? getStringField(value, "userName");
	const prefixedText = userName && !isBot ? `[${userName}] ${text}` : text;

	return createDocument({
		id: `${basename(path)}:${lineNumber}`,
		source: "log",
		path,
		timestamp,
		role,
		text: prefixedText,
		maxChars,
	});
}

async function parseJsonlFile(
	path: string,
	source: SessionSearchSource,
	maxChars: number,
): Promise<SessionSearchDocument[]> {
	const content = await readOptionalFile(path);
	if (!content.trim()) {
		return [];
	}

	const docs: SessionSearchDocument[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const parsed = parseJsonLine(lines[index] ?? "");
		if (parsed === null) {
			continue;
		}
		const document =
			source === "log"
				? parseLogEntry(parsed, path, index + 1, maxChars)
				: parseSessionEntry(parsed, path, index + 1, source, maxChars);
		if (document) {
			docs.push(document);
		}
	}
	return docs;
}

async function listChannelSessionJsonlFiles(channelDir: string, maxFiles: number): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(channelDir);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const candidates: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of names) {
		if (!name.endsWith(".jsonl") || IGNORED_JSONL_FILES.has(name)) {
			continue;
		}
		const path = join(channelDir, name);
		try {
			const stats = await stat(path);
			if (!stats.isFile()) {
				continue;
			}
			candidates.push({ path, mtimeMs: stats.mtimeMs });
		} catch {}
	}

	return candidates
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, Math.max(0, maxFiles))
		.map((entry) => entry.path);
}

export async function buildSessionCorpus(options: BuildSessionCorpusOptions): Promise<SessionSearchDocument[]> {
	const maxFiles = Math.max(1, Math.floor(options.maxFiles));
	const maxChars = options.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;
	const maxDocuments = options.maxDocumentsTotal ?? DEFAULT_MAX_DOCUMENTS_TOTAL;
	const docs: SessionSearchDocument[] = [];
	const readPlan: Array<{ path: string; source: SessionSearchSource }> = [
		{ path: join(options.channelDir, "context.jsonl"), source: "context" },
		{ path: join(options.channelDir, "log.jsonl"), source: "log" },
		{ path: join(options.channelDir, "log.jsonl.1"), source: "log" },
	];

	for (const path of await listChannelSessionJsonlFiles(options.channelDir, maxFiles)) {
		readPlan.push({ path, source: "session" });
	}

	for (const item of readPlan.slice(0, maxFiles + 3)) {
		docs.push(...(await parseJsonlFile(item.path, item.source, maxChars)));
		if (docs.length > maxDocuments * 2) {
			break;
		}
	}

	if (docs.length > maxDocuments) {
		return docs.slice(-maxDocuments);
	}
	return docs;
}
