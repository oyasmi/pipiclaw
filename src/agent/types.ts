import type { MemoryMaintenanceRuntimeContext } from "../memory/scheduler.js";
import type { ChannelContext } from "../runtime/channel-context.js";
import type { ChannelStore } from "../runtime/store.js";
import type { UsageTotals } from "../shared/types.js";
import type { BuiltInCommand } from "./commands.js";

export interface RunnerStatusSnapshot {
	model: string;
	contextTokens?: number;
	contextWindow: number;
	thinkingLevel: string;
	/** Present only while running on the backup model (spec 017). */
	fallback?: { primary: string; cooldownUntilMs: number };
}

export interface AgentRunner {
	run(
		ctx: ChannelContext,
		store: ChannelStore,
	): Promise<{
		stopReason: string;
		errorMessage?: string;
		usage?: UsageTotals;
		durationMs?: number;
	}>;
	handleBuiltinCommand(ctx: ChannelContext, command: BuiltInCommand): Promise<void>;
	queueSteer(text: string, userName?: string): Promise<void>;
	flushMemoryForShutdown(): Promise<void>;
	getMemoryMaintenanceContext(): Promise<MemoryMaintenanceRuntimeContext>;
	getStatusSnapshot(): RunnerStatusSnapshot;
	abort(): Promise<void>;
}

export type FinalOutcome = { kind: "none" } | { kind: "silent" } | { kind: "final"; text: string };

export interface PendingTool {
	toolName: string;
	args: unknown;
	startTime: number;
}

export interface RunQueue {
	enqueue(fn: () => Promise<void>, errorContext: string): void;
	enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
}

export interface RunLogContext {
	channelId: string;
	userName?: string;
	channelName?: string;
}

export interface RunState {
	ctx: ChannelContext | null;
	logCtx: RunLogContext | null;
	store: ChannelStore | null;
	queue: RunQueue | null;
	pendingTools: Map<string, PendingTool>;
	totalUsage: UsageTotals;
	/** Main-loop assistant usage only (excludes sub-agents). Feeds the turn ledger entry. */
	assistantUsage: UsageTotals;
	stopReason: string;
	errorMessage: string | undefined;
	lastCompactionError: string | undefined;
	finalOutcome: FinalOutcome;
	finalResponseDelivered: boolean;
}

export function createEmptyRunState(): RunState {
	return {
		ctx: null,
		logCtx: null,
		store: null,
		queue: null,
		pendingTools: new Map(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		assistantUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined,
		lastCompactionError: undefined,
		finalOutcome: { kind: "none" },
		finalResponseDelivered: false,
	};
}

export interface AssistantUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total?: number;
	totalTokens?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type AssistantContentPart =
	| { type: "thinking"; thinking: string }
	| { type: "text"; text: string }
	| { type: "toolCall" }
	| { type: string; [key: string]: unknown };

export interface AssistantEventMessage {
	role: "assistant";
	content: AssistantContentPart[];
	stopReason?: string;
	errorMessage?: string;
	usage?: AssistantUsage;
}

export interface AssistantUsageMessage {
	role: "assistant";
	stopReason?: string;
	usage: AssistantUsage;
	responseModel?: string;
}

export type SessionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "message_start"; message: unknown }
	| { type: "message_end"; message: unknown }
	| { type: "turn_end"; message: unknown; toolResults: unknown[] }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason?: "manual" | "threshold" | "overflow";
			result?: { tokensBefore: number };
			aborted?: boolean;
			errorMessage?: string;
			willRetry?: boolean;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs?: number; errorMessage: string };

export type ToolExecutionStartEvent = Extract<SessionEvent, { type: "tool_execution_start" }>;
export type ToolExecutionUpdateEvent = Extract<SessionEvent, { type: "tool_execution_update" }>;
export type ToolExecutionEndEvent = Extract<SessionEvent, { type: "tool_execution_end" }>;
export type MessageStartEvent = Extract<SessionEvent, { type: "message_start" }>;
export type MessageEndEvent = Extract<SessionEvent, { type: "message_end" }>;
export type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;
export type AutoCompactionStartEvent = Extract<SessionEvent, { type: "compaction_start" }>;
export type AutoCompactionEndEvent = Extract<SessionEvent, { type: "compaction_end" }>;
export type AutoRetryStartEvent = Extract<SessionEvent, { type: "auto_retry_start" }>;

export type ProgressEntryKind = "tool" | "thinking" | "error" | "assistant";

export const MAX_USER_MESSAGE_CHARS = 12_000;
