import { styleText } from "node:util";
import { RUNTIME_LOG_PATH } from "./paths.js";
import { createJsonlAppender, type JsonlAppender } from "./shared/jsonl-appender.js";

export interface LogContext {
	channelId: string;
	userName?: string;
	channelName?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
	ts: string;
	level: LogLevel;
	event: string;
	channelId?: string;
	userName?: string;
	message: string;
	details?: string;
	fields?: Record<string, unknown>;
}

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
const SENSITIVE_TEXT =
	/\b(?:authorization|cookie|token|api[_-]?key|secret|password)\s*[:=]\s*[^\s,;]+|\bbearer\s+[^\s,;]+/gi;

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
	const redacted = value.replace(SENSITIVE_TEXT, (match) => {
		const separator = match.includes(":") ? ":" : match.includes("=") ? "=" : " ";
		return `${match.split(separator, 1)[0]}${separator}[REDACTED]`;
	});
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

function formatTimestamp(date = new Date()): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
	const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
	return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${sign}${offsetHours}:${offsetRemainder}`;
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
	return `${formatTimestamp()} ${level.toUpperCase().padEnd(5)} ${event} ${summarizeString(message)}${suffix ? ` ${suffix}` : ""}`;
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
	void fileSink.append({
		ts: new Date().toISOString(),
		level,
		event,
		message: summarizeString(message),
		...(options.ctx ? { channelId: options.ctx.channelId, userName: options.ctx.userName } : {}),
		...(details ? { details } : {}),
		...(fields ? { fields } : {}),
	});
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
// the same output contract as structured events.
function legacyContext(message: string): { message: string; ctx?: LogContext } {
	const match = /^\[([A-Za-z0-9._-]+)\]\s*/.exec(message);
	return match ? { message: message.slice(match[0].length), ctx: { channelId: match[1] } } : { message };
}

export function logInfo(message: string, details?: string): void {
	const legacy = legacyContext(message);
	logEvent("info", "system.info", legacy.message, {
		ctx: legacy.ctx,
		...(details ? { details, fields: { reason: details } } : {}),
	});
}

export function logWarning(message: string, details?: string): void {
	const legacy = legacyContext(message);
	logEvent("warn", "system.warning", legacy.message, {
		ctx: legacy.ctx,
		...(details ? { details, fields: { reason: details } } : {}),
	});
}

export function logError(message: string, details?: string): void {
	const legacy = legacyContext(message);
	logEvent("error", "system.error", legacy.message, {
		ctx: legacy.ctx,
		...(details ? { details, fields: { reason: details } } : {}),
	});
}

export function logModelFallback(ctx: LogContext, from: string, to: string, error: string): void {
	logEvent("warn", "agent.model.fallback", "Using fallback model", { ctx, fields: { from, to, error } });
}

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
): string {
	const formatTokens = (count: number): string => {
		if (count < 1000) return count.toString();
		if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
		if (count < 1000000) return `${Math.round(count / 1000)}k`;
		return `${(count / 1000000).toFixed(1)}M`;
	};

	const lines = [
		"**Usage Summary**",
		`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`,
		...(usage.cacheRead > 0 || usage.cacheWrite > 0
			? [`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`]
			: []),
		...(contextTokens && contextWindow
			? [
					`Context: ${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${((contextTokens / contextWindow) * 100).toFixed(1)}%)`,
				]
			: []),
		`Cost: $${usage.cost.input.toFixed(4)} in, $${usage.cost.output.toFixed(4)} out` +
			(usage.cacheRead > 0 || usage.cacheWrite > 0
				? `, $${usage.cost.cacheRead.toFixed(4)} cache read, $${usage.cost.cacheWrite.toFixed(4)} cache write`
				: ""),
		`**Total: $${usage.cost.total.toFixed(4)}** (incl. sub-agents)`,
	];
	logEvent("info", "agent.usage", "Usage recorded", {
		ctx,
		fields: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost,
		},
	});
	return lines.join("\n");
}

export function logStartup(workingDir: string): void {
	logEvent("info", "runtime.started", "Starting pipiclaw", { fields: { workingDir } });
}

export function logConnected(): void {
	logEvent("info", "runtime.dingtalk.connected", "Connected and listening");
}
