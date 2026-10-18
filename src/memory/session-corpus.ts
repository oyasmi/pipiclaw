import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isNodeError, readOptionalTextFile } from "../shared/os.js";
import { isRecord } from "../shared/type-guards.js";

export type SessionSearchSource = "context" | "session" | "log";
export type SessionSearchRole = "user" | "assistant" | "tool" | "system" | "unknown";

export interface SessionSearchDocument {
	id: string;
	source: SessionSearchSource;
	path: string;
	timestamp?: string;
	role: SessionSearchRole;
	/** The full scannable message text (up to {@link SESSION_SCAN_MAX_CHARS}) — matching runs on
	 * this, display windows are cut from it at query time (fix plan §2.5). */
	text: string;
	/** True when even the scan text was clipped: a keyword past this point cannot be found here. */
	scanTruncated?: boolean;
	sessionId?: string;
	/** The conversation directory the document came from (`dm-1`, `group-2`, …). */
	conversation?: string;
}

/**
 * Ceiling on how much of one message is kept for *matching*. The old code clipped each message to
 * the small display window at ingest, so a keyword in the middle of a long message was gone from
 * the corpus entirely and widening the query could never bring it back. This is deliberately much
 * larger than the display window; a single pathological message still cannot blow out memory.
 */
export const SESSION_SCAN_MAX_CHARS = 20_000;

export interface BuildSessionCorpusOptions {
	/** The dot whose conversations — every channel that has talked to it — form the corpus (spec 058, D12). */
	dotDir: string;
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
	// The ingest clip is a fixed, generous scan cap — not the caller's display window. Trimming for
	// display happens later, at query time, centered on the match (fix plan §2.5). `params.maxChars`
	// is kept in the signature for callers that still pass it but no longer drives the clip.
	const raw = params.text.trim();
	if (!raw) {
		return null;
	}
	const scanTruncated = raw.length > SESSION_SCAN_MAX_CHARS;
	return {
		id: params.id,
		source: params.source,
		path: params.path,
		timestamp: params.timestamp,
		role: params.role,
		text: scanTruncated ? raw.slice(0, SESSION_SCAN_MAX_CHARS) : raw,
		...(scanTruncated ? { scanTruncated: true } : {}),
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

	// Command traffic (help/status/tasks/... echoes) is marked skipContextSync at write time
	// (runtime/bootstrap.ts) so it never comes back as memory-extraction input.
	if (value.skipContextSync === true) {
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
	const content = await readOptionalTextFile(path);
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

async function listConversations(dotDir: string): Promise<string[]> {
	try {
		const entries = await readdir(join(dotDir, "conversations"), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function listSessionJsonlFiles(
	conversationDirs: Array<{ conversation: string; dir: string }>,
	maxFiles: number,
): Promise<Array<{ conversation: string; path: string }>> {
	// Stat in parallel: one round trip per session file, and awaiting them one at a time made the
	// corpus build scale with the file count rather than with the slowest stat.
	const listed = await Promise.all(
		conversationDirs.map(async ({ conversation, dir }) => {
			try {
				return (await readdir(dir))
					.filter((name) => name.endsWith(".jsonl") && !IGNORED_JSONL_FILES.has(name))
					.map((name) => ({ conversation, path: join(dir, name) }));
			} catch {
				return [];
			}
		}),
	);
	const stated = await Promise.all(
		listed.flat().map(async (entry) => {
			try {
				const stats = await stat(entry.path);
				return stats.isFile() ? { ...entry, mtimeMs: stats.mtimeMs } : null;
			} catch {
				return null;
			}
		}),
	);
	return stated
		.filter((entry): entry is { conversation: string; path: string; mtimeMs: number } => entry !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, Math.max(0, maxFiles))
		.map(({ conversation, path }) => ({ conversation, path }));
}

export async function buildSessionCorpus(options: BuildSessionCorpusOptions): Promise<SessionSearchDocument[]> {
	const maxFiles = Math.max(1, Math.floor(options.maxFiles));
	const maxChars = options.maxCharsPerDocument ?? DEFAULT_MAX_CHARS_PER_DOCUMENT;
	const maxDocuments = options.maxDocumentsTotal ?? DEFAULT_MAX_DOCUMENTS_TOTAL;
	const conversationDirs = (await listConversations(options.dotDir)).map((conversation) => ({
		conversation,
		dir: join(options.dotDir, "conversations", conversation),
	}));
	const readPlan: Array<{ path: string; source: SessionSearchSource; conversation: string }> = [];
	for (const { conversation, dir } of conversationDirs) {
		readPlan.push(
			{ path: join(dir, "context.jsonl"), source: "context", conversation },
			{ path: join(dir, "log.jsonl"), source: "log", conversation },
			{ path: join(dir, "log.jsonl.1"), source: "log", conversation },
		);
	}
	for (const entry of await listSessionJsonlFiles(conversationDirs, maxFiles)) {
		readPlan.push({ ...entry, source: "session" });
	}

	// Every conversation is read, each keeping at most its newest `maxDocuments`; the total is then
	// shared out by `shareBudget`. Stopping in directory order once the total ran over let one
	// long-lived channel fill the budget before later channels were read at all (spec 058, D12:
	// `session_search` covers the whole dot).
	const byConversation = new Map<string, SessionSearchDocument[]>();
	for (const item of readPlan) {
		let docs = byConversation.get(item.conversation) ?? [];
		for (const document of await parseJsonlFile(item.path, item.source, maxChars)) {
			// Ids are `<file>:<line>`, and every conversation has its own `context.jsonl`.
			docs.push({ ...document, id: `${item.conversation}/${document.id}`, conversation: item.conversation });
		}
		if (docs.length > maxDocuments * 2) docs = docs.slice(-maxDocuments);
		byConversation.set(item.conversation, docs);
	}
	return shareBudget([...byConversation.values()].map(deduplicate), maxDocuments);
}

function deduplicate(docs: SessionSearchDocument[]): SessionSearchDocument[] {
	const deduplicated: SessionSearchDocument[] = [];
	const seen = new Set<string>();
	for (const document of docs) {
		const identity = document.timestamp
			? `${document.timestamp}\0${document.role}\0${document.text}`
			: `${document.source}\0${document.id}`;
		if (seen.has(identity)) continue;
		seen.add(identity);
		deduplicated.push(document);
	}
	return deduplicated;
}

/**
 * Fair shares of `budget`, smallest conversation first: one that needs less than an equal share
 * keeps everything and leaves the rest to the others; a larger one keeps its newest documents.
 */
function shareBudget(groups: SessionSearchDocument[][], budget: number): SessionSearchDocument[] {
	const kept = new Map<SessionSearchDocument[], SessionSearchDocument[]>();
	let remaining = budget;
	const bySize = [...groups].sort((a, b) => a.length - b.length);
	bySize.forEach((group, index) => {
		const take = Math.min(group.length, Math.floor(remaining / (bySize.length - index)));
		kept.set(group, take === 0 ? [] : group.slice(-take));
		remaining -= take;
	});
	return groups.flatMap((group) => kept.get(group) ?? []);
}
