import { styleText } from "node:util";
import { RUNTIME_LOG_PATH } from "./paths.js";
import { createJsonlAppender, type JsonlAppender } from "./shared/jsonl-appender.js";

export interface LogContext {
	channelId: string;
	userName?: string;
	channelName?: string;
}

// ============================================================================
// Structured log sink layer
//
// The console sink below is the human-readable output and is treated as a
// frozen asset: its formatting must never change. Each logX helper additionally
// assembles a structured LogRecord and hands it to an optional file sink. Call
// sites stay untouched — the structure is built here from existing parameters.
// ============================================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
	ts: string; // ISO 8601 (UTC)
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

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function readEnvLevel(): LogLevel | undefined {
	const raw = process.env.PIPICLAW_LOG_LEVEL?.trim().toLowerCase();
	if (raw && raw in LEVEL_ORDER) {
		return raw as LogLevel;
	}
	return undefined;
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
	// Honor an explicit env opt-in even before settings are loaded, so the
	// earliest startup logs are captured. Defaults match DEFAULT_LOGGING.
	envFileEnabled === true
		? createJsonlAppender({ path: RUNTIME_LOG_PATH, maxSizeBytes: 5_000_000, maxRotations: 3 })
		: null;

/**
 * Configure the file sink from loaded settings. Env vars take precedence and
 * have already applied at module load; this reconciles the two.
 */
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

function emit(
	level: LogLevel,
	event: string,
	message: string,
	extra?: { ctx?: LogContext; details?: string; fields?: Record<string, unknown> },
): void {
	if (!fileSink) return;
	if (LEVEL_ORDER[level] < LEVEL_ORDER[thresholdLevel]) return;
	const record: LogRecord = {
		ts: new Date().toISOString(),
		level,
		event,
		message,
		...(extra?.ctx ? { channelId: extra.ctx.channelId, userName: extra.ctx.userName } : {}),
		...(extra?.details ? { details: extra.details } : {}),
		...(extra?.fields ? { fields: extra.fields } : {}),
	};
	void fileSink.append(record);
}

let consoleEnabled = true;

/**
 * Toggle the human-readable console sink. The TUI disables it so structured
 * logging does not corrupt the pi-tui frame (which owns stdout); the file sink
 * is unaffected, so logs are still captured when file logging is enabled.
 */
export function setConsoleLoggingEnabled(enabled: boolean): void {
	consoleEnabled = enabled;
}

function con(...args: unknown[]): void {
	if (consoleEnabled) console.log(...args);
}

function color(style: Parameters<typeof styleText>[0], text: string): string {
	return styleText(style, text);
}

function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

function formatContext(ctx: LogContext): string {
	// DMs: [DM:username]
	// Groups: [group:channelId:username]
	if (ctx.channelId.startsWith("dm_")) {
		return `[DM:${ctx.userName || ctx.channelId}]`;
	}
	const channel = ctx.channelName || ctx.channelId;
	const user = ctx.userName || "unknown";
	return `[${channel}:${user}]`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen)}\n(truncated at ${maxLen} chars)`;
}

function formatToolArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		if (key === "label") continue;

		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		if (key === "offset" || key === "limit") continue;

		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// User messages
export function logUserMessage(ctx: LogContext, text: string): void {
	con(color("green", `${timestamp()} ${formatContext(ctx)} ${text}`));
	emit("info", "user_message", text, { ctx });
}

// Tool execution
export function logToolStart(ctx: LogContext, toolName: string, label: string, args: Record<string, unknown>): void {
	const formattedArgs = formatToolArgs(args);
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} ↳ ${toolName}: ${label}`));
	if (formattedArgs) {
		const indented = formattedArgs
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		con(color("dim", indented));
	}
	emit("debug", "tool_start", `${toolName}: ${label}`, {
		ctx,
		details: formattedArgs || undefined,
		fields: { toolName, label },
	});
}

export function logToolSuccess(ctx: LogContext, toolName: string, durationMs: number, result: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} ✓ ${toolName} (${duration}s)`));

	const truncated = truncate(result, 1000);
	if (truncated) {
		const indented = truncated
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		con(color("dim", indented));
	}
	emit("info", "tool_end", toolName, {
		ctx,
		details: truncated || undefined,
		fields: { toolName, durationMs, isError: false },
	});
}

export function logToolError(ctx: LogContext, toolName: string, durationMs: number, error: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} ✗ ${toolName} (${duration}s)`));

	const truncated = truncate(error, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	con(color("dim", indented));
	emit("error", "tool_end", toolName, {
		ctx,
		details: truncated,
		fields: { toolName, durationMs, isError: true },
	});
}

// Response streaming
export function logResponseStart(ctx: LogContext): void {
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} → Streaming response...`));
	emit("debug", "response_start", "Streaming response...", { ctx });
}

export function logThinking(ctx: LogContext, thinking: string): void {
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} 💭 Thinking`));
	const truncated = truncate(thinking, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	con(color("dim", indented));
	emit("debug", "thinking", "Thinking", { ctx, details: truncated });
}

export function logResponse(ctx: LogContext, text: string): void {
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} 💬 Response`));
	const truncated = truncate(text, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	con(color("dim", indented));
	emit("info", "response", "Response", { ctx, details: truncated });
}

// System
export function logInfo(message: string): void {
	con(color("blue", `${timestamp()} [system] ${message}`));
	emit("info", "system", message);
}

export function logWarning(message: string, details?: string): void {
	con(color("yellow", `${timestamp()} [system] ⚠ ${message}`));
	if (details) {
		const indented = details
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		con(color("dim", indented));
	}
	emit("warn", "system", message, { details });
}

export function logAgentError(ctx: LogContext | "system", error: string): void {
	const context = ctx === "system" ? "[system]" : formatContext(ctx);
	con(color("yellow", `${timestamp()} ${context} ✗ Agent error`));
	const indented = error
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	con(color("dim", indented));
	emit("error", "agent_error", "Agent error", {
		ctx: ctx === "system" ? undefined : ctx,
		details: error,
	});
}

// Model fallback (spec 017)
export function logModelFallback(ctx: LogContext, from: string, to: string, error: string): void {
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} ⤳ Fallback ${from} → ${to}`));
	emit("warn", "model_fallback", `Fallback ${from} → ${to}`, {
		ctx,
		details: error,
		fields: { from, to, error },
	});
}

// Usage summary
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

	const lines: string[] = [];
	lines.push("**Usage Summary**");
	lines.push(`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`);
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		lines.push(`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`);
	}
	if (contextTokens && contextWindow) {
		const contextPercent = ((contextTokens / contextWindow) * 100).toFixed(1);
		lines.push(`Context: ${formatTokens(contextTokens)} / ${formatTokens(contextWindow)} (${contextPercent}%)`);
	}
	lines.push(
		`Cost: $${usage.cost.input.toFixed(4)} in, $${usage.cost.output.toFixed(4)} out` +
			(usage.cacheRead > 0 || usage.cacheWrite > 0
				? `, $${usage.cost.cacheRead.toFixed(4)} cache read, $${usage.cost.cacheWrite.toFixed(4)} cache write`
				: ""),
	);
	lines.push(`**Total: $${usage.cost.total.toFixed(4)}** (incl. sub-agents)`);

	const summary = lines.join("\n");

	// Log to console
	con(color("yellow", `${timestamp()} ${formatContext(ctx)} 💰 Usage`));
	con(
		color(
			"dim",
			`           ${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out` +
				(usage.cacheRead > 0 || usage.cacheWrite > 0
					? ` (${usage.cacheRead.toLocaleString()} cache read, ${usage.cacheWrite.toLocaleString()} cache write)`
					: "") +
				` = $${usage.cost.total.toFixed(4)}`,
		),
	);
	emit("info", "usage", `Total $${usage.cost.total.toFixed(4)} (incl. sub-agents)`, {
		ctx,
		fields: {
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				cost: usage.cost,
			},
		},
	});

	return summary;
}

// Startup
export function logStartup(workingDir: string): void {
	con("Starting pipiclaw...");
	con(`  Working directory: ${workingDir}`);
}

export function logConnected(): void {
	con("⚡️ pipiclaw connected and listening!");
	con("");
}
