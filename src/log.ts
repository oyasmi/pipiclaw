import { styleText } from "node:util";
import { RUNTIME_LOG_PATH } from "./paths.js";
import { createJsonlAppender, type JsonlAppender } from "./shared/jsonl-appender.js";
import { formatLocalTime } from "./shared/local-time.js";

export interface LogContext {
	channelId: string;
	userName?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggingConfig {
	level: LogLevel;
	file: { enabled: boolean; maxSizeBytes: number; maxFiles: number };
}

export interface LogOptions {
	ctx?: LogContext;
	details?: string;
	fields?: Record<string, unknown>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_VALUE_LENGTH = 240;
const MAX_COLLECTION_ITEMS = 10;
const SENSITIVE_KEY =
	/(?:api[_-]?key|authorization|cookie|credential|password|secret|private[_-]?key|(?:^|[_-])token(?:$|[_-])|token$|^env(?:ironment)?$)/i;
/**
 * Free-text secret redaction. Group 1 is everything that must survive — the key and its
 * separator, or a bare `bearer` scheme — and everything after it is the value, replaced whole.
 *
 * Two details are load-bearing. The value swallows an optional auth-scheme word, because
 * `Authorization: Bearer <token>` otherwise ends the match at the space after "Bearer": the
 * scheme got redacted, the token survived, and the `bearer` alternative could not re-match a
 * region the first alternative had already consumed. And the surviving prefix comes from a
 * capture group rather than being reconstructed by splitting the match on a guessed separator —
 * a value containing `:` (`token=abc:def`) made that guess pick the wrong one and leave the
 * first half of the secret in the log.
 */
const SENSITIVE_TEXT =
	/(\b(?:authorization|cookie|token|api[_-]?key|secret|password)"?\s*[:=]\s*|\bbearer\s+)"?(?:(?:bearer|basic|token|digest)\s+)?[^\s,;"']+"?/gi;

function readEnvLevel(): LogLevel | undefined {
	const raw = process.env.PIPICLAW_LOG_LEVEL?.trim().toLowerCase();
	return raw && raw in LEVEL_ORDER ? (raw as LogLevel) : undefined;
}

function readEnvFileEnabled(): boolean | undefined {
	const raw = process.env.PIPICLAW_LOG_FILE?.trim();
	if (raw === "1" || raw === "true") return true;
	if (raw === "0" || raw === "false") return false;
	return undefined;
}

const envLevel = readEnvLevel();
const envFileEnabled = readEnvFileEnabled();
let thresholdLevel: LogLevel = envLevel ?? "info";
let fileSink: JsonlAppender | null =
	envFileEnabled === true
		? createJsonlAppender({ path: RUNTIME_LOG_PATH, maxSizeBytes: 5_000_000, maxRotations: 3 })
		: null;
let consoleEnabled = true;

/** Configure both console filtering and the optional structured file sink. */
export function configureLogging(config: LoggingConfig): void {
	thresholdLevel = envLevel ?? config.level;
	const enabled = envFileEnabled ?? config.file.enabled;
	fileSink = enabled
		? createJsonlAppender({
				path: RUNTIME_LOG_PATH,
				maxSizeBytes: config.file.maxSizeBytes,
				maxRotations: config.file.maxFiles,
			})
		: null;
}

/** The TUI owns stdout, so its runtime logs are file-only. */
export function setConsoleLoggingEnabled(enabled: boolean): void {
	consoleEnabled = enabled;
}

function isEnabled(level: LogLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[thresholdLevel];
}

function summarizeString(value: string): string {
	const redacted = value.replace(SENSITIVE_TEXT, (_match, keyAndSeparator: string) => `${keyAndSeparator}[REDACTED]`);
	const normalized = redacted.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_VALUE_LENGTH
		? `${normalized.slice(0, MAX_VALUE_LENGTH)}… (length=${normalized.length})`
		: normalized;
}

/**
 * Keep logging safe and cheap: redact values by conventional sensitive keys,
 * flatten multiline strings, and bound nested diagnostic values.
 */
function sanitizeValue(value: unknown, key?: string, depth = 0): unknown {
	if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
	if (typeof value === "string") return summarizeString(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (value === undefined) return undefined;
	if (value instanceof Error) return summarizeString(value.message);
	if (depth >= 2) return "[summary omitted]";
	if (Array.isArray(value)) {
		return value.slice(0, MAX_COLLECTION_ITEMS).map((item) => sanitizeValue(item, undefined, depth + 1));
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
			const sanitized = sanitizeValue(childValue, childKey, depth + 1);
			if (sanitized !== undefined) result[childKey] = sanitized;
		}
		return result;
	}
	return summarizeString(String(value));
}

function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!fields) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		const sanitized = sanitizeValue(value, key);
		if (sanitized !== undefined) result[key] = sanitized;
	}
	return result;
}

function renderField(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	try {
		return JSON.stringify(value);
	} catch {
		return JSON.stringify("[unserializable]");
	}
}

function formatConsoleLine(level: LogLevel, event: string, message: string, options: LogOptions): string {
	const fields: Record<string, unknown> = {
		...(options.ctx
			? { channel: options.ctx.channelId, ...(options.ctx.userName ? { user: options.ctx.userName } : {}) }
			: {}),
		...sanitizeFields(options.fields),
	};
	const suffix = Object.entries(fields)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${renderField(value)}`)
		.join(" ");
	return `${formatLocalTime()} ${level.toUpperCase().padEnd(5)} ${event} ${summarizeString(message)}${suffix ? ` ${suffix}` : ""}`;
}

function colorFor(level: LogLevel): Parameters<typeof styleText>[0] {
	if (level === "debug") return "dim";
	if (level === "warn") return "yellow";
	if (level === "error") return "red";
	return "blue";
}

function writeConsole(level: LogLevel, event: string, message: string, options: LogOptions): void {
	if (!consoleEnabled || !isEnabled(level)) return;
	console.log(styleText(colorFor(level), formatConsoleLine(level, event, message, options)));
}

function emit(level: LogLevel, event: string, message: string, options: LogOptions): void {
	if (!fileSink || !isEnabled(level)) return;
	const fields = sanitizeFields(options.fields);
	const details = options.details ? summarizeString(options.details) : undefined;
	fileSink.tryAppend(
		{
			ts: formatLocalTime(),
			level,
			event,
			message: summarizeString(message),
			...(options.ctx ? { channelId: options.ctx.channelId, userName: options.ctx.userName } : {}),
			...(details ? { details } : {}),
			...(fields ? { fields } : {}),
		},
		level === "warn" || level === "error" ? "critical" : "normal",
	);
}

/** Wait for structured logs accepted so far to reach disk. */
export async function flushLogging(): Promise<void> {
	await fileSink?.flush();
}

/** Emit one consistently formatted runtime event to stdout and the JSONL sink. */
export function logEvent(level: LogLevel, event: string, message: string, options: LogOptions = {}): void {
	writeConsole(level, event, message, options);
	emit(level, event, message, options);
}

function formatToolArgs(args: Record<string, unknown>): Record<string, unknown> {
	const { label: _label, ...rest } = args;
	return rest;
}

// Tool execution is diagnostic by default. Failures remain visible because they
// are useful even when an agent can recover in the same turn.
export function logToolStart(ctx: LogContext, toolName: string, label: string, args: Record<string, unknown>): void {
	logEvent("debug", "agent.tool.started", label, { ctx, fields: { tool: toolName, args: formatToolArgs(args) } });
}

export function logToolSuccess(ctx: LogContext, toolName: string, durationMs: number, result: string): void {
	logEvent("debug", "agent.tool.finished", "Tool completed", {
		ctx,
		details: result,
		fields: { tool: toolName, durationMs, resultLength: result.length },
	});
}

/**
 * A tool call the model can fix itself (bad arguments, unmet precondition). Logged at debug,
 * not warn: it is an expected step in a self-correcting turn, not an operator problem. Kept
 * distinct from success so a model looping on the same rejection is still visible in the log.
 */
export function logToolRejected(ctx: LogContext, toolName: string, durationMs: number, reason: string): void {
	logEvent("debug", "agent.tool.rejected", "Tool rejected the call", {
		ctx,
		details: reason,
		fields: { tool: toolName, durationMs, reason },
	});
}

export function logToolError(ctx: LogContext, toolName: string, durationMs: number, error: string): void {
	logEvent("warn", "agent.tool.failed", "Tool failed", {
		ctx,
		details: error,
		fields: { tool: toolName, durationMs, error },
	});
}

export function logResponseStart(ctx: LogContext): void {
	logEvent("debug", "agent.response.started", "Streaming response", { ctx });
}

export function logThinking(ctx: LogContext, thinking: string): void {
	logEvent("debug", "agent.thinking", "Thinking", { ctx, details: thinking, fields: { length: thinking.length } });
}

export function logResponse(ctx: LogContext, text: string): void {
	logEvent("debug", "agent.response.finished", "Response ready", {
		ctx,
		details: text,
		fields: { length: text.length },
	});
}

// Compatibility helpers keep lower-risk call sites centralized while they use
// the same output contract as structured events. The channel prefix accepts any non-blank id:
// a group channel is `dingtalk:group:<conversationId>`, and DingTalk conversation ids are base64 (`+`, `/`,
// `=`), which a word-character class silently failed to match — group logs lost their `channel`.
function legacyContext(message: string): { message: string; ctx?: LogContext } {
	const match = /^\[([^\]\s]+)\]\s*/.exec(message);
	return match ? { message: message.slice(match[0].length), ctx: { channelId: match[1] } } : { message };
}

export function logInfo(message: string, details?: string): void {
	const legacy = legacyContext(message);
	logEvent("info", "system.info", legacy.message, {
		ctx: legacy.ctx,
		...(details ? { details, fields: { reason: details } } : {}),
	});
}

export interface EventLogOptions {
	channelId?: string;
	/** Why it happened (an error message, a rejection). Kept out of `message` so the message stays greppable. */
	reason?: string;
	/** Ids and counts the event is about. */
	fields?: Record<string, unknown>;
}

/**
 * One runtime event with a filterable `<domain>.<object>.<verb>` name (spec 053, D12). `message`
 * is a fixed sentence (`<Subject> failed`); what varies goes to `reason` and `fields`, which the
 * console line and the JSONL record both carry.
 */
function logNamedEvent(level: LogLevel, event: string, message: string, options: EventLogOptions): void {
	const fields = { ...options.fields, ...(options.reason ? { reason: options.reason } : {}) };
	logEvent(level, event, message, {
		...(options.channelId ? { ctx: { channelId: options.channelId } } : {}),
		...(options.reason ? { details: options.reason } : {}),
		...(Object.keys(fields).length > 0 ? { fields } : {}),
	});
}

export function logWarn(event: string, message: string, options: EventLogOptions = {}): void {
	logNamedEvent("warn", event, message, options);
}

export function logInfoEvent(event: string, message: string, options: EventLogOptions = {}): void {
	logNamedEvent("info", event, message, options);
}

export function logDebugEvent(event: string, message: string, options: EventLogOptions = {}): void {
	logNamedEvent("debug", event, message, options);
}

export function logModelFallback(ctx: LogContext, from: string, to: string, error: string): void {
	logEvent("warn", "agent.model.fallback", "Using fallback model", { ctx, fields: { from, to, error } });
}

/** One structured record per turn's usage; the context fill rides along when known. */
export function logUsageSummary(
	ctx: LogContext,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
	contextTokens?: number,
	contextWindow?: number,
): void {
	logEvent("info", "agent.usage", "Usage recorded", {
		ctx,
		fields: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
			...(contextTokens && contextWindow ? { contextTokens, contextWindow } : {}),
		},
	});
}

export function logStartup(workingDir: string): void {
	logEvent("info", "runtime.started", "Starting pipiclaw", { fields: { workingDir } });
}

export function logConnected(): void {
	logEvent("info", "runtime.dingtalk.connected", "Connected and listening");
}
