/**
 * Translates SDK session events into the turn's structured output events (`TurnEvent`), usage
 * accounting and memory activity for the current turn. Nothing here decides how an event looks:
 * the channel's transport renders it.
 */
import { realpathSync } from "node:fs";
import type { ChannelStore } from "../../channel/store.js";
import * as log from "../../log.js";
import type { MemoryLifecycle } from "../../memory/lifecycle.js";
import { renderGuardBlockForUser } from "../../security/block-message.js";
import { truncate } from "../../shared/text-utils.js";
import { isRecord } from "../../shared/type-guards.js";
import {
	isArgumentValidationFailure,
	isRecoverableRejection,
	type ToolDetails,
	takeGuardBlock,
	toolResultDetails,
} from "../../tools/contract/details.js";
import { describeToolCall } from "../../tools/contract/presentation.js";
import type { SubAgentToolDetails } from "../../tools/subagent.js";
import type { UsageLedger } from "../../usage/ledger.js";
import { addUsage, type UsageTotals } from "../../usage/totals.js";
import { extractToolResultText } from "../turn/progress-formatter.js";
import { renderCompactionFailure } from "../turn/turn-error.js";
import type { TurnOutput } from "../turn/turn-output.js";
import type { AssistantUsage, PendingTool, RunLogContext, RunQueue, RunState } from "../types.js";
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
	isUserEventMessage,
} from "./event-guards.js";

export interface SessionEventHandlerContext {
	ctx: TurnOutput;
	logCtx: RunLogContext;
	queue: RunQueue;
	pendingTools: Map<string, PendingTool>;
	store: ChannelStore | null;
	runState: RunState;
	memoryLifecycle: MemoryLifecycle;
	ledger: UsageLedger;
	isModelCostKnown?: (modelReference: string) => boolean;
	refreshSessionResources?: () => Promise<void>;
	/** Both absolute skill roots; resolve them again after writes (they may have been created). */
	skillsDirs?: string[];
}

/**
 * A `write`/`edit` result whose resolved target landed inside either skill tree. The
 * `skill` tool is read-only (spec 045); authoring a workspace skill goes through the generic file
 * tools, so this is the only way the runtime learns "the skill catalog may have changed" — no
 * per-tool `requiresResourceRefresh` flag to keep in sync any more.
 */
function isSkillWrite(
	toolName: string,
	details: unknown,
	skillsDirs: string[],
): details is ToolDetails & { path: string } {
	if (toolName !== "write" && toolName !== "edit") {
		return false;
	}
	if (!isRecord(details) || typeof details.path !== "string") {
		return false;
	}
	const path = details.path;
	return skillsDirs.some((root) => {
		if (path === root || path.startsWith(`${root}/`)) return true;
		let resolvedRoot: string;
		try {
			resolvedRoot = realpathSync(root);
		} catch {
			return false;
		}
		return path === resolvedRoot || path.startsWith(`${resolvedRoot}/`);
	});
}

/** How much of a tool's result a `tool.end` event carries; the full text stays in the log and the session. */
const TOOL_EVENT_OUTPUT_CHARS = 4000;

function firstLine(text: string): string {
	return text.trim().split("\n", 1)[0] ?? "";
}

function mergeSubAgentUsage(totalUsage: UsageTotals, details: SubAgentToolDetails): void {
	addUsage(totalUsage, details.usage);
}

function mergeAssistantUsage(runState: RunState, usage: AssistantUsage): void {
	// totalUsage stays the console-summary tally (assistant + sub-agents).
	// assistantUsage is the ledger's assistant-only "turn" tally.
	addUsage(runState.totalUsage, usage);
	addUsage(runState.assistantUsage, usage);
}

export async function handleSessionEvent(event: unknown, context: SessionEventHandlerContext): Promise<void> {
	const { ctx, logCtx, queue, pendingTools, runState, memoryLifecycle } = context;

	if (isToolExecutionStartEvent(event)) {
		const label = describeToolCall(event.toolName, event.args);

		pendingTools.set(event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			startTime: Date.now(),
		});
		memoryLifecycle.noteToolCall();

		log.logToolStart(logCtx, event.toolName, label, isRecord(event.args) ? event.args : {});
		ctx.emit({ type: "tool.start", callId: event.toolCallId, tool: event.toolName, args: event.args });
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
		ctx.emit({ type: "tool.update", callId: event.toolCallId, text: partialText });
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
			// Spec 040, D7: `runs.ts` is the sole settlement/ledger/archive authority for every
			// delegation run, sync or async, so its own `settle()` writes the ledger entry and the
			// archive record exactly once. This handler only folds the run's usage into the current
			// turn's displayed total — a dispatched-placeholder result contributes whatever usage
			// had accrued by the time the grace window elapsed, fine for a live tally; the ledger
			// entry `runs.ts` writes later carries the true total.
			mergeSubAgentUsage(runState.totalUsage, subAgentDetails);
			runState.usageSources++;
			runState.costKnown &&=
				subAgentDetails.usage.cost.total > 0 || (context.isModelCostKnown?.(subAgentDetails.model) ?? false);
		}

		const details = toolResultDetails(event.result);
		if (
			!event.isError &&
			context.skillsDirs &&
			context.refreshSessionResources &&
			isSkillWrite(event.toolName, details, context.skillsDirs)
		) {
			queue.enqueue(() => context.refreshSessionResources?.() ?? Promise.resolve(), "refresh skills");
			queue.enqueue(async () => {
				ctx.emit({ type: "commentary", text: "已更新技能，下一条消息起生效。", level: "notice" });
			}, "skill notice");
		}

		// A recoverable rejection (bad arguments, unmet precondition the model can fix) is not a
		// fault: the model normally corrects it on the next call. It is logged so the retry is
		// still diagnosable, but never rendered to the user — a red bubble would report a failure
		// that never happened and make the assistant look broken mid-turn. Rejections the *user*
		// must resolve (a security guard refusal or an external decision) stay plain errors and remain visible.
		// Spec 047, D4.2: a schema-validation failure is rejected by the SDK before `execute`, so it
		// never passes through `withToolDetails` and carries no `recoverable` flag — but it is still
		// something the model fixes by re-issuing correct arguments, so it must not surface as a
		// user-visible error. `event.isError` is true for it, so it has to win over `treatAsError`.
		const rejected =
			isRecoverableRejection(event.result) || isArgumentValidationFailure(event.result, event.isError === true);
		const treatAsError = (event.isError || Boolean(subAgentDetails?.failed)) && !rejected;
		if (treatAsError) {
			log.logToolError(logCtx, event.toolName, durationMs, resultStr);
		} else if (rejected) {
			log.logToolRejected(logCtx, event.toolName, durationMs, resultStr);
		} else {
			log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
		}

		// The task lane's idle-step detector reads this: a step that completed no tool did nothing
		// (spec 051, D6; spec 064, D16).
		if (!treatAsError && !rejected) {
			runState.toolsUsed.push(event.toolName);
		}

		// Claimed on every error, shown or not, so the parked refusal never outlives its call.
		const blocked = event.isError ? takeGuardBlock(event.toolCallId, resultStr) : undefined;
		// The tool's error text is written for the model (spec 053, D2): a guard refusal is shown
		// from its structured form; anything else as its first line only — the full text is in
		// the log (`agent.tool.failed`).
		const failure = treatAsError
			? blocked
				? renderGuardBlockForUser(blocked)
				: truncate(firstLine(resultStr), 120)
			: undefined;
		ctx.emit({
			type: "tool.end",
			callId: event.toolCallId,
			ok: !event.isError && !subAgentDetails?.failed,
			output: truncate(resultStr, TOOL_EVENT_OUTPUT_CHARS),
			...(failure ? { failure } : {}),
		});
		return;
	}

	if (isMessageStartEvent(event)) {
		if (isAssistantEventMessage(event.message)) {
			log.logResponseStart(logCtx);
		} else if (isUserEventMessage(event.message)) {
			// The turn's own prompt is the first user message; any later one is a steering or
			// follow-up message the SDK injected into the running loop.
			runState.userMessagesStarted++;
			if (runState.userMessagesStarted > 1) ctx.emit({ type: "steer.applied" });
		}
		return;
	}

	if (isMessageEndEvent(event)) {
		const commandResultText = extractCustomCommandResultText(event.message);
		if (commandResultText) {
			runState.finalOutcome = { kind: "final", text: commandResultText };
			log.logResponse(logCtx, commandResultText);
			runState.answerEmitted = true;
			ctx.emit({ type: "answer", text: commandResultText });
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
				runState.usageSources++;
				runState.assistantUsageSources++;
				const modelReference =
					assistantMsg.provider && assistantMsg.model
						? `${assistantMsg.provider}/${assistantMsg.model}`
						: assistantMsg.model;
				const costKnown =
					assistantMsg.usage.cost.total > 0 ||
					(modelReference ? (context.isModelCostKnown?.(modelReference) ?? false) : false);
				runState.costKnown &&= costKnown;
				runState.assistantCostKnown &&= costKnown;
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
			if (text.trim()) runState.lastAssistantText = text;

			for (const thinking of thinkingParts) {
				log.logThinking(logCtx, thinking);
				ctx.emit({ type: "reasoning", text: thinking });
			}

			if (text.trim() && hasToolCalls) {
				ctx.emit({ type: "commentary", text });
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
			runState.answerEmitted = true;
			ctx.emit({ type: "answer", text: finalText });
		}
		return;
	}

	if (isAutoCompactionStartEvent(event)) {
		log.logEvent("info", "agent.compaction.started", "Compaction started", {
			ctx: logCtx,
			fields: { reason: event.reason },
		});
		ctx.emit({ type: "compaction", phase: "start" });
		return;
	}

	if (isAutoCompactionEndEvent(event)) {
		if (event.result) {
			runState.lastCompactionError = undefined;
			log.logEvent("info", "agent.compaction.finished", "Compaction completed", {
				ctx: logCtx,
				fields: { tokensBefore: event.result.tokensBefore },
			});
			ctx.emit({ type: "compaction", phase: "end", ok: true });
		} else if (event.aborted) {
			log.logEvent("info", "agent.compaction.aborted", "Compaction aborted", { ctx: logCtx });
			ctx.emit({ type: "compaction", phase: "end", ok: false });
		} else if (event.errorMessage) {
			runState.lastCompactionError = event.errorMessage;
			log.logEvent("warn", "agent.compaction.failed", "Compaction failed", {
				ctx: logCtx,
				fields: { error: event.errorMessage },
			});
			ctx.emit({ type: "compaction", phase: "end", ok: false });
			ctx.emit({ type: "commentary", text: renderCompactionFailure(event.errorMessage ?? ""), level: "error" });
		}
		return;
	}

	if (isAutoRetryStartEvent(event)) {
		log.logEvent("warn", "agent.retrying", "Retrying model request", {
			ctx: logCtx,
			fields: { attempt: event.attempt, maxAttempts: event.maxAttempts, error: event.errorMessage },
		});
		ctx.emit({ type: "commentary", text: `模型请求失败，正在重试（${event.attempt}/${event.maxAttempts}）…` });
	}
}
