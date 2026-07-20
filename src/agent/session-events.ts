import * as log from "../log.js";
import type { MemoryLifecycle } from "../memory/lifecycle.js";
import type { ChannelContext } from "../runtime/channel-context.js";
import type { ChannelStore } from "../runtime/store.js";
import { extractLabelFromArgs, truncate } from "../shared/text-utils.js";
import { isRecord } from "../shared/type-guards.js";
import type { UsageTotals } from "../shared/types.js";
import type { SubAgentToolDetails } from "../subagents/tool.js";
import { type ToolDetails, toolResultDetails } from "../tools/tool-details.js";
import type { UsageLedger } from "../usage/ledger.js";
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
	ctx: ChannelContext;
	logCtx: RunLogContext;
	queue: RunQueue;
	pendingTools: Map<string, PendingTool>;
	store: ChannelStore | null;
	runState: RunState;
	memoryLifecycle: MemoryLifecycle;
	ledger: UsageLedger;
	refreshSessionResources?: () => Promise<void>;
}

function isSkillManageDetails(value: unknown): value is ToolDetails & {
	kind: "skill_manage";
	requiresResourceRefresh?: boolean;
	notice?: string;
} {
	return isRecord(value) && value.kind === "skill_manage";
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

function addUsage(
	target: UsageTotals,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total?: number;
		totalTokens?: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.total += usage.total ?? usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
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
	// totalUsage stays the console-summary tally (assistant + sub-agents).
	// assistantUsage is the ledger's assistant-only "turn" tally.
	addUsage(runState.totalUsage, usage);
	addUsage(runState.assistantUsage, usage);
}

export async function handleSessionEvent(event: unknown, context: SessionEventHandlerContext): Promise<void> {
	const { ctx, logCtx, queue, pendingTools, store, runState, memoryLifecycle, ledger } = context;
	const showProgress = ctx.progressStyle !== "none";
	const finalToCard = ctx.finalDelivery === "card";

	if (isToolExecutionStartEvent(event)) {
		const label = extractLabelFromArgs(event.args) || event.toolName;

		pendingTools.set(event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			startTime: Date.now(),
		});
		memoryLifecycle.noteToolCall();

		log.logToolStart(logCtx, event.toolName, label, isRecord(event.args) ? event.args : {});
		if (showProgress) {
			queue.enqueue(() => ctx.respond(formatProgressEntry("tool", label), false), "tool label");
		}
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
		if (showProgress) {
			queue.enqueue(() => ctx.respond(formatProgressEntry("tool", partialText), false), "tool update");
		}
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
			ledger.record({
				channelId: logCtx.channelId,
				kind: "subagent",
				model: subAgentDetails.model,
				label,
				usage: {
					input: subAgentDetails.usage.input,
					output: subAgentDetails.usage.output,
					cacheRead: subAgentDetails.usage.cacheRead,
					cacheWrite: subAgentDetails.usage.cacheWrite,
					total: subAgentDetails.usage.total,
				},
				cost: { ...subAgentDetails.usage.cost },
			});
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

		const details = toolResultDetails(event.result);
		if (isSkillManageDetails(details)) {
			if (details.requiresResourceRefresh && context.refreshSessionResources) {
				queue.enqueue(() => context.refreshSessionResources?.() ?? Promise.resolve(), "refresh skills");
			}
			if (details.notice) {
				queue.enqueue(() => ctx.respondInThread(details.notice ?? ""), "skill notice");
			}
		}

		// A recoverable rejection (bad arguments, unmet precondition the model can fix) is not a
		// fault: the model normally corrects it on the next call. It is logged so the retry is
		// still diagnosable, but never rendered to the user — a red bubble would report a failure
		// that never happened and make the assistant look broken mid-turn. Rejections the *user*
		// must resolve (an approval gate, a guard refusal) stay plain errors and remain visible.
		const rejected = details?.recoverable === true;
		const treatAsError = event.isError || Boolean(subAgentDetails?.failed);
		if (treatAsError) {
			log.logToolError(logCtx, event.toolName, durationMs, resultStr);
		} else if (rejected) {
			log.logToolRejected(logCtx, event.toolName, durationMs, resultStr);
		} else {
			log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
		}

		if (treatAsError && showProgress) {
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
				if (finalToCard) {
					await ctx.replaceMessage(commandResultText);
				} else {
					const delivered = await ctx.respondPlain(commandResultText);
					if (!delivered) {
						await ctx.replaceMessage(commandResultText);
					}
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

			if (showProgress) {
				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					queue.enqueue(() => ctx.respond(formatProgressEntry("thinking", thinking), false), "thinking");
				}
			}

			if (text.trim() && hasToolCalls && showProgress) {
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
				// No tool calls and no text: leaving finalOutcome at its "none" default means no
				// delivery branch in channel-runner fires, so the progress card is stuck on
				// "thinking…" forever. Treat it the same as an explicit [SILENT] turn.
				runState.finalOutcome = { kind: "silent" };
				memoryLifecycle.noteCompletedAssistantTurn();
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
				if (finalToCard) {
					await ctx.replaceMessage(finalText);
					runState.finalResponseDelivered = true;
				} else {
					const delivered = await ctx.respondPlain(finalText);
					if (delivered) {
						runState.finalResponseDelivered = true;
					}
				}
			}, "final response");
		}
		return;
	}

	if (isAutoCompactionStartEvent(event)) {
		const label = "Compacting context...";
		log.logEvent("info", "agent.compaction.started", "Compaction started", {
			ctx: logCtx,
			fields: { reason: event.reason },
		});
		if (showProgress) {
			queue.enqueue(() => ctx.respond(formatProgressEntry("assistant", label), false), "compaction start");
		}
		return;
	}

	if (isAutoCompactionEndEvent(event)) {
		if (event.result) {
			runState.lastCompactionError = undefined;
			log.logEvent("info", "agent.compaction.finished", "Compaction completed", {
				ctx: logCtx,
				fields: { tokensBefore: event.result.tokensBefore },
			});
		} else if (event.aborted) {
			log.logEvent("info", "agent.compaction.aborted", "Compaction aborted", { ctx: logCtx });
		} else if (event.errorMessage) {
			runState.lastCompactionError = event.errorMessage;
			log.logEvent("warn", "agent.compaction.failed", "Compaction failed", {
				ctx: logCtx,
				fields: { error: event.errorMessage },
			});
			if (showProgress) {
				queue.enqueue(
					() =>
						ctx.respond(
							formatProgressEntry("error", truncate(event.errorMessage ?? "Compaction failed", 200)),
							false,
						),
					"compaction error",
				);
			}
		}
		return;
	}

	if (isAutoRetryStartEvent(event)) {
		log.logEvent("warn", "agent.retrying", "Retrying model request", {
			ctx: logCtx,
			fields: { attempt: event.attempt, maxAttempts: event.maxAttempts, error: event.errorMessage },
		});
		if (showProgress) {
			queue.enqueue(
				() =>
					ctx.respond(
						formatProgressEntry("assistant", `Retrying (${event.attempt}/${event.maxAttempts})...`),
						false,
					),
				"retry",
			);
		}
	}
}
