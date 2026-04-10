import * as log from "../log.js";
import type { MemoryLifecycle } from "../memory/lifecycle.js";
import type { DingTalkContext } from "../runtime/dingtalk.js";
import type { ChannelStore } from "../runtime/store.js";
import { extractLabelFromArgs, truncate } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { UsageTotals } from "../shared/types.js";
import type { SubAgentToolDetails } from "../subagents/tool.js";
import { extractToolResultText, formatProgressEntry } from "./progress-formatter.js";
import {
	extractCustomCommandResultText,
	isAssistantEventMessage,
	isAutoCompactionEndEvent,
	isAutoCompactionStartEvent,
	isAutoRetryStartEvent,
	isMessageEndEvent,
	isMessageStartEvent,
	isSubAgentToolDetails,
	isTextPart,
	isThinkingPart,
	isToolExecutionEndEvent,
	isToolExecutionStartEvent,
	isToolExecutionUpdateEvent,
	isTurnEndEvent,
} from "./type-guards.js";
import type { PendingTool, RunLogContext, RunQueue, RunState } from "./types.js";

export interface SessionEventHandlerContext {
	ctx: DingTalkContext;
	logCtx: RunLogContext;
	queue: RunQueue;
	pendingTools: Map<string, PendingTool>;
	store: ChannelStore | null;
	runState: RunState;
	memoryLifecycle: MemoryLifecycle;
}

function mergeSubAgentUsage(totalUsage: UsageTotals, details: SubAgentToolDetails): void {
	totalUsage.input += details.usage.input;
	totalUsage.output += details.usage.output;
	totalUsage.cacheRead += details.usage.cacheRead;
	totalUsage.cacheWrite += details.usage.cacheWrite;
	totalUsage.total += details.usage.total;
	totalUsage.cost.input += details.usage.cost.input;
	totalUsage.cost.output += details.usage.cost.output;
	totalUsage.cost.cacheRead += details.usage.cost.cacheRead;
	totalUsage.cost.cacheWrite += details.usage.cost.cacheWrite;
	totalUsage.cost.total += details.usage.cost.total;
}

function mergeAssistantUsage(
	runState: RunState,
	usage: NonNullable<Extract<unknown, unknown>> & {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total?: number;
		totalTokens?: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): void {
	runState.totalUsage.input += usage.input;
	runState.totalUsage.output += usage.output;
	runState.totalUsage.cacheRead += usage.cacheRead;
	runState.totalUsage.cacheWrite += usage.cacheWrite;
	runState.totalUsage.total +=
		usage.total ?? usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	runState.totalUsage.cost.input += usage.cost.input;
	runState.totalUsage.cost.output += usage.cost.output;
	runState.totalUsage.cost.cacheRead += usage.cost.cacheRead;
	runState.totalUsage.cost.cacheWrite += usage.cost.cacheWrite;
	runState.totalUsage.cost.total += usage.cost.total;
}

export async function handleSessionEvent(event: unknown, context: SessionEventHandlerContext): Promise<void> {
	const { ctx, logCtx, queue, pendingTools, store, runState, memoryLifecycle } = context;

	if (isToolExecutionStartEvent(event)) {
		const label = extractLabelFromArgs(event.args) || event.toolName;

		pendingTools.set(event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			startTime: Date.now(),
		});
		memoryLifecycle.noteToolCall();

		log.logToolStart(logCtx, event.toolName, label, isRecord(event.args) ? event.args : {});
		queue.enqueue(() => ctx.respond(formatProgressEntry("tool", label), false), "tool label");
		return;
	}

	if (isToolExecutionUpdateEvent(event)) {
		if (event.toolName !== "subagent") {
			return;
		}
		const partialText = truncate(extractToolResultText(event.partialResult), 200);
		if (!partialText.trim()) {
			return;
		}
		queue.enqueue(() => ctx.respond(formatProgressEntry("tool", partialText), false), "tool update");
		return;
	}

	if (isToolExecutionEndEvent(event)) {
		const resultStr = extractToolResultText(event.result);
		const pending = pendingTools.get(event.toolCallId);
		pendingTools.delete(event.toolCallId);

		const durationMs = pending ? Date.now() - pending.startTime : 0;
		const subAgentDetails =
			event.toolName === "subagent" &&
			isRecord(event.result) &&
			"details" in event.result &&
			isSubAgentToolDetails((event.result as { details?: unknown }).details)
				? (event.result as { details: SubAgentToolDetails }).details
				: null;

		if (subAgentDetails) {
			mergeSubAgentUsage(runState.totalUsage, subAgentDetails);
			const label =
				pending?.args &&
				typeof pending.args === "object" &&
				"label" in pending.args &&
				typeof (pending.args as { label?: unknown }).label === "string"
					? ((pending.args as { label: string }).label ?? "subagent").trim()
					: "subagent";
			queue.enqueue(
				() =>
					store?.logSubAgentRun(logCtx.channelId, {
						date: new Date().toISOString(),
						toolCallId: event.toolCallId,
						label,
						agent: subAgentDetails.agent,
						source: subAgentDetails.source,
						model: subAgentDetails.model,
						tools: [...subAgentDetails.tools],
						turns: subAgentDetails.turns,
						toolCalls: subAgentDetails.toolCalls,
						durationMs: subAgentDetails.durationMs,
						failed: subAgentDetails.failed,
						failureReason: subAgentDetails.failureReason,
						output: resultStr.length > 16000 ? resultStr.slice(0, 16000) : resultStr,
						outputTruncated: resultStr.length > 16000,
						usage: {
							...subAgentDetails.usage,
							cost: { ...subAgentDetails.usage.cost },
						},
					}) ?? Promise.resolve(),
				"sub-agent run log",
			);
		}

		const treatAsError = event.isError || Boolean(subAgentDetails?.failed);
		if (treatAsError) {
			log.logToolError(logCtx, event.toolName, durationMs, resultStr);
		} else {
			log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
		}

		if (treatAsError) {
			queue.enqueue(() => ctx.respond(formatProgressEntry("error", truncate(resultStr, 200)), false), "tool error");
		}
		return;
	}

	if (isMessageStartEvent(event)) {
		if (isAssistantEventMessage(event.message)) {
			log.logResponseStart(logCtx);
		}
		return;
	}

	if (isMessageEndEvent(event)) {
		const commandResultText = extractCustomCommandResultText(event.message);
		if (commandResultText) {
			runState.finalOutcome = { kind: "final", text: commandResultText };
			log.logResponse(logCtx, commandResultText);
			queue.enqueue(async () => {
				const delivered = await ctx.respondPlain(commandResultText);
				if (!delivered) {
					await ctx.replaceMessage(commandResultText);
				}
				runState.finalResponseDelivered = true;
			}, "command result");
			return;
		}

		if (isAssistantEventMessage(event.message)) {
			const assistantMsg = event.message;

			if (assistantMsg.stopReason) {
				runState.stopReason = assistantMsg.stopReason;
			}
			if (assistantMsg.errorMessage) {
				runState.errorMessage = assistantMsg.errorMessage;
			}

			if (assistantMsg.usage) {
				mergeAssistantUsage(runState, assistantMsg.usage);
			}

			const thinkingParts: string[] = [];
			const textParts: string[] = [];
			let hasToolCalls = false;
			for (const part of assistantMsg.content) {
				if (isThinkingPart(part)) {
					thinkingParts.push(part.thinking);
				} else if (isTextPart(part)) {
					textParts.push(part.text);
				} else if (part.type === "toolCall") {
					hasToolCalls = true;
				}
			}

			const text = textParts.join("\n");

			for (const thinking of thinkingParts) {
				log.logThinking(logCtx, thinking);
				queue.enqueue(() => ctx.respond(formatProgressEntry("thinking", thinking), false), "thinking");
			}

			if (hasToolCalls && text.trim()) {
				queue.enqueue(() => ctx.respond(formatProgressEntry("assistant", text), false), "assistant progress");
			}
		}
		return;
	}

	if (isTurnEndEvent(event)) {
		if (isAssistantEventMessage(event.message) && event.toolResults.length === 0) {
			if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
				return;
			}

			const finalText = event.message.content
				.filter((part): part is { type: "text"; text: string } => isTextPart(part))
				.map((part) => part.text)
				.join("\n");

			const trimmedFinalText = finalText.trim();
			if (!trimmedFinalText) {
				return;
			}

			if (trimmedFinalText === "[SILENT]" || trimmedFinalText.startsWith("[SILENT]")) {
				runState.finalOutcome = { kind: "silent" };
				memoryLifecycle.noteCompletedAssistantTurn();
				return;
			}

			if (runState.finalOutcome.kind === "final" && runState.finalOutcome.text.trim() === trimmedFinalText) {
				return;
			}

			runState.finalOutcome = { kind: "final", text: finalText };
			memoryLifecycle.noteCompletedAssistantTurn();
			log.logResponse(logCtx, finalText);
			queue.enqueue(async () => {
				const delivered = await ctx.respondPlain(finalText);
				if (delivered) {
					runState.finalResponseDelivered = true;
				}
			}, "final response");
		}
		return;
	}

	if (isAutoCompactionStartEvent(event)) {
		const label = event.reason === "manual" ? "Compacting context..." : "Compacting context...";
		log.logInfo(`Compaction started (reason: ${event.reason})`);
		queue.enqueue(() => ctx.respond(formatProgressEntry("assistant", label), false), "compaction start");
		return;
	}

	if (isAutoCompactionEndEvent(event)) {
		if (event.result) {
			runState.lastCompactionError = undefined;
			log.logInfo(`Compaction complete: ${event.result.tokensBefore} tokens compacted`);
		} else if (event.aborted) {
			log.logInfo("Compaction aborted");
		} else if (event.errorMessage) {
			runState.lastCompactionError = event.errorMessage;
			log.logWarning("Compaction failed", event.errorMessage);
			queue.enqueue(
				() =>
					ctx.respond(
						formatProgressEntry("error", truncate(event.errorMessage ?? "Compaction failed", 200)),
						false,
					),
				"compaction error",
			);
		}
		return;
	}

	if (isAutoRetryStartEvent(event)) {
		log.logWarning(`Retrying (${event.attempt}/${event.maxAttempts})`, event.errorMessage);
		queue.enqueue(
			() =>
				ctx.respond(formatProgressEntry("assistant", `Retrying (${event.attempt}/${event.maxAttempts})...`), false),
			"retry",
		);
	}
}
