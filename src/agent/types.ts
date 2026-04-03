import type { DingTalkContext } from "../runtime/dingtalk.js";
import type { ChannelStore } from "../runtime/store.js";
import type { UsageTotals } from "../shared/types.js";
import type { BuiltInCommand } from "./commands.js";

export interface AgentRunner {
	run(ctx: DingTalkContext, store: ChannelStore): Promise<{ stopReason: string; errorMessage?: string }>;
	handleBuiltinCommand(ctx: DingTalkContext, command: BuiltInCommand): Promise<void>;
	queueSteer(text: string, userName?: string): Promise<void>;
	queueFollowUp(text: string, userName?: string): Promise<void>;
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
	ctx: DingTalkContext | null;
	logCtx: RunLogContext | null;
	store: ChannelStore | null;
	queue: RunQueue | null;
	pendingTools: Map<string, PendingTool>;
	totalUsage: UsageTotals;
	stopReason: string;
	errorMessage: string | undefined;
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
		stopReason: "stop",
		errorMessage: undefined,
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
}

export type SessionEvent =
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
	| { type: "message_start"; message: unknown }
	| { type: "message_end"; message: unknown }
	| { type: "turn_end"; message: unknown; toolResults: unknown[] }
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
	| { type: "auto_compaction_end"; result?: { tokensBefore: number }; aborted?: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs?: number; errorMessage: string };

export type ToolExecutionStartEvent = Extract<SessionEvent, { type: "tool_execution_start" }>;
export type ToolExecutionUpdateEvent = Extract<SessionEvent, { type: "tool_execution_update" }>;
export type ToolExecutionEndEvent = Extract<SessionEvent, { type: "tool_execution_end" }>;
export type MessageStartEvent = Extract<SessionEvent, { type: "message_start" }>;
export type MessageEndEvent = Extract<SessionEvent, { type: "message_end" }>;
export type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;
export type AutoCompactionStartEvent = Extract<SessionEvent, { type: "auto_compaction_start" }>;
export type AutoCompactionEndEvent = Extract<SessionEvent, { type: "auto_compaction_end" }>;
export type AutoRetryStartEvent = Extract<SessionEvent, { type: "auto_retry_start" }>;

export type ProgressEntryKind = "tool" | "thinking" | "error" | "assistant";

export const MAX_USER_MESSAGE_CHARS = 12_000;
