import { readdir } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { getConversationsDir, SUBAGENT_RUNS_LOG_FILENAME } from "../desk/paths.js";
import { isNodeError } from "../shared/os.js";
import { isRecord } from "../shared/type-guards.js";
import { redactSecrets } from "./secret-redaction.js";
import { stripInjectedMemoryContext } from "./transcript.js";

export type SessionSearchSource = "context" | "session" | "log" | "task";
export type SessionSearchRole = "user" | "assistant" | "tool" | "system" | "unknown";

export interface TranscriptSourceFile {
	path: string;
	relPath: string;
	kind: "session" | "log" | "task";
	source: SessionSearchSource;
	conversation?: string;
}

export interface TranscriptDoc {
	role: SessionSearchRole;
	text: string;
	truncated: boolean;
	speaker?: string;
	ts?: string;
}

const MAX_DOC_CHARS = 200_000;
const IGNORED_JSONL_FILES = new Set([SUBAGENT_RUNS_LOG_FILENAME, "memory-review.jsonl"]);
const ISO_PREFIX = String.raw`\[\d{4}-\d{2}-\d{2}[^\]\r\n]{0,30}\]`;
const SPEAKER_PREFIX = String.raw`\[([^\]\r\n]{1,64})\]:`;
const ATTRIBUTION = new RegExp(`^(?:\\s*(${ISO_PREFIX})[ \t]*)?(?:${SPEAKER_PREFIX}[ \t]*)?`);

function normalizeRole(value: unknown): SessionSearchRole {
	if (value === "user" || value === "assistant" || value === "tool" || value === "system") return value;
	if (value === "bot") return "assistant";
	if (value === "toolResult") return "tool";
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

function getStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function createDocument(role: SessionSearchRole, raw: string, ts?: string, speaker?: string): TranscriptDoc | null {
	let text = raw.trim();
	if (role === "user") {
		text = stripInjectedMemoryContext(text);
		const prefix = ATTRIBUTION.exec(text);
		if (prefix?.[0]) {
			ts = prefix[1]?.slice(1, -1) ?? ts;
			speaker = prefix[2] ?? speaker;
			text = text.slice(prefix[0].length).trim();
		}
	}
	if (!text) return null;

	// Redact before clipping so a boundary cannot turn a secret into an unrecognized fragment.
	text = redactSecrets(text);
	if (role === "tool" && text.length > 4_000) text = `${text.slice(0, 3_000)}\n[…]\n${text.slice(-1_000)}`;
	const truncated = text.length > MAX_DOC_CHARS;
	return {
		role,
		text: text.slice(0, MAX_DOC_CHARS),
		truncated,
		speaker: speaker && redactSecrets(speaker),
		ts,
	};
}

export function parseTranscriptLine(source: SessionSearchSource, value: unknown): TranscriptDoc | null {
	if (!isRecord(value)) return null;
	if (source === "log") {
		if (value.skipContextSync === true) return null;
		const bot = value.isBot === true;
		return createDocument(
			bot ? "assistant" : "user",
			getStringField(value, "text") ?? "",
			getStringField(value, "date") ?? getStringField(value, "ts"),
			bot ? undefined : (getStringField(value, "displayName") ?? getStringField(value, "userName")),
		);
	}
	const message = isRecord(value.message) ? value.message : value;
	return createDocument(
		normalizeRole(message.role),
		getStringField(message, "text") ?? extractContentText(message.content),
		getStringField(value, "timestamp") ?? getStringField(value, "date"),
	);
}

export function dedupKey(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.replace(ATTRIBUTION, ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

export async function listIndexSourceEntries(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

export async function listDeskTranscriptSources(deskDir: string): Promise<TranscriptSourceFile[]> {
	const conversationsDir = getConversationsDir(deskDir);
	const conversations = (await listIndexSourceEntries(conversationsDir)).filter((entry) => entry.isDirectory());
	const archiveDir = join(deskDir, "tasks", "archive");
	const [conversationsFiles, taskFiles] = await Promise.all([
		Promise.all(
			conversations.map(async ({ name: conversation }) => {
				const dir = join(conversationsDir, conversation);
				const files: TranscriptSourceFile[] = [];
				for (const entry of await listIndexSourceEntries(dir)) {
					if (!entry.isFile() || IGNORED_JSONL_FILES.has(entry.name)) continue;
					const isLog = /^log\.jsonl(?:\.\d+)?$/.test(entry.name);
					if (!isLog && (!entry.name.endsWith(".jsonl") || entry.name.startsWith("log.jsonl"))) continue;
					const path = join(dir, entry.name);
					files.push({
						path,
						relPath: relative(deskDir, path).split(sep).join("/"),
						conversation,
						kind: isLog ? "log" : "session",
						source: isLog ? "log" : entry.name === "context.jsonl" ? "context" : "session",
					});
				}
				return files;
			}),
		),
		listIndexSourceEntries(archiveDir),
	]);
	return [
		...conversationsFiles.flat(),
		...taskFiles
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map(
				({ name }) =>
					({
						path: join(archiveDir, name),
						relPath: `tasks/archive/${name}`,
						kind: "task",
						source: "task",
					}) as const,
			),
	];
}

export function archivedTaskDoc(
	mdPath: string,
	markdown: string,
	logContent: string,
	mtimeMs: number,
): TranscriptDoc | null {
	if (!markdown.trim()) return null;
	const id = basename(mdPath, ".md");
	const logNotes: string[] = [];
	let closedAt: string | undefined;
	for (const line of logContent.split(/\r?\n/)) {
		const parsed = parseJsonLine(line);
		if (!isRecord(parsed)) continue;
		if (parsed.kind === "report" && typeof parsed.text === "string" && parsed.text.trim()) {
			logNotes.push(`[汇报] ${parsed.text.trim()}`);
		} else if (parsed.kind === "ask" && typeof parsed.question === "string" && parsed.question.trim()) {
			logNotes.push(`[提问] ${parsed.question.trim()}`);
		} else if (parsed.kind === "message" && typeof parsed.text === "string" && parsed.text.trim()) {
			logNotes.push(`[用户消息] ${parsed.text.trim()}`);
		} else if (parsed.kind === "close" || parsed.kind === "closed") {
			closedAt = getStringField(parsed, "ts") ?? closedAt;
			const outcome = getStringField(parsed, "outcome") ?? "closed";
			const note = getStringField(parsed, "note");
			logNotes.push(`[结项 ${outcome}]${note ? ` ${note}` : ""}`);
		}
	}
	const frontmatterClosedAt = /^closedAt:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(markdown)?.[1]?.trim();
	const timestamp = closedAt ?? frontmatterClosedAt ?? new Date(mtimeMs).toISOString();
	const combined = logNotes.length > 0 ? `${markdown.trim()}\n\n${logNotes.join("\n")}` : markdown.trim();
	return createDocument("assistant", `[归档任务 ${id}]\n${combined}`, timestamp);
}

export function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return null;
	}
}
