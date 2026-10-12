/**
 * Turning a finished internal worker into what the run hands back: the tool result for the model
 * and the `SettleInput` for the run manager — covering success, a failure with output, a failure
 * without any (which rejects), and the best-effort settle input for that rejecting path.
 */
import { formatModelReference } from "../../models/reference.js";
import { RecoverableToolError } from "../../shared/recoverable-error.js";
import { extractAssistantText } from "../../shared/text-utils.js";
import type { ResolvedInternalSubAgentConfig } from "../discovery.js";
import { buildFailureText, buildStoppedText, createDetails, finalizeSubAgentOutput, formatStatus } from "../result.js";
import type { SettleInput } from "../run-record.js";
import type { DelegationResult, SubAgentRunContext, SubAgentWorker } from "../types.js";
import { resolveVerificationVerdict } from "../verification-outcome.js";
import { changedPathsSummary, type WorkspaceBaseline } from "../workspace-summary.js";
import type { InternalRunState } from "./state.js";
import { getLastAssistantMessage } from "./worker.js";

/**
 * Assemble the result of a finished worker. Rejects only for the single fatal case (no assistant
 * message at all) — every other outcome, including a budget abort or explicit cancel, is a normal
 * (if failed) result.
 */
export async function buildInternalOutcome(input: {
	worker: SubAgentWorker;
	config: ResolvedInternalSubAgentConfig;
	runContext: SubAgentRunContext;
	state: InternalRunState;
	mutatesNote: string;
	workspaceBaseline: WorkspaceBaseline | undefined;
	emitUpdate: (text: string) => void;
}): Promise<{ toolResult: DelegationResult; settleInput: SettleInput }> {
	const { worker, config, runContext, state, mutatesNote, emitUpdate } = input;
	const { usage } = state;
	const lastAssistantMessage = getLastAssistantMessage(worker.state.messages);
	const durationMs = Date.now() - state.startedAt;
	const modelRef = state.fallbackNote ? formatModelReference(state.activeModel) : undefined;
	const fallbackLine = state.fallbackNote ? `Note: this run ${state.fallbackNote}.\n\n` : "";
	if (!lastAssistantMessage) {
		state.failureReason = state.failureReason || "Sub-agent returned no assistant message";
		emitUpdate(formatStatus(config.name, "failed"));
		throw new Error(`Sub-agent ${config.name} failed: ${state.failureReason}`);
	}

	const finalText = extractAssistantText(lastAssistantMessage);
	const effectiveFailureReason =
		state.failureReason ||
		(lastAssistantMessage.stopReason === "error" || lastAssistantMessage.stopReason === "aborted"
			? lastAssistantMessage.errorMessage || `Sub-agent stopped with ${lastAssistantMessage.stopReason}`
			: undefined);
	// The pass/fail rule is shared with the external verify path (spec 042 D1): one place
	// deciding what a verify run's own output proves. Spec 052, D6: it is the checker's declared
	// verdict, recorded for the leader to weigh — not a runtime-enforced gate.
	const verificationVerdict =
		runContext.purpose === "verify"
			? resolveVerificationVerdict({ finalText, runFailed: Boolean(effectiveFailureReason) })
			: undefined;

	// Internal runs always report full usage; cost is "unknown" only for the shape a
	// free/local model produces (tokens spent, nothing billed) — external harnesses
	// override both explicitly once they land (D4/D9).
	const costKnown = usage.cost.total > 0 || usage.total === 0;
	const baseSettleInput = {
		usage,
		usageKnown: true,
		costKnown,
		turns: state.assistantTurns,
		toolCalls: state.toolCalls,
		durationMs,
		verificationVerdict,
		model: modelRef,
	};

	if (effectiveFailureReason) {
		if (!finalText.trim()) {
			emitUpdate(formatStatus(config.name, "failed"));
			// Settlement records the reason itself, not the next-step advice wrapped around it below.
			state.failureReason = effectiveFailureReason;
			// The delegating model can act on this alone — re-dispatch, narrow the task, or do the
			// work itself — so it is not a user-facing error bubble.
			throw new RecoverableToolError(
				`${fallbackLine}${buildFailureText(config, effectiveFailureReason, finalText)}\n` +
					`Retry the delegation (narrower if it hit a budget), or do the work directly; subagent_run op=show runId=${runContext.runId} has the details.`,
			);
		}
		emitUpdate(formatStatus(config.name, "stopped"));
		const finalized = finalizeSubAgentOutput(runContext, finalText);
		return {
			toolResult: {
				content: [
					{
						type: "text",
						text:
							mutatesNote + fallbackLine + buildStoppedText(config, effectiveFailureReason, finalized.replyText),
					},
				],
				details: createDetails({
					config,
					runContext,
					usage,
					turns: state.assistantTurns,
					toolCalls: state.toolCalls,
					durationMs,
					failed: true,
					failureReason: effectiveFailureReason,
					verificationVerdict,
					resultTruncated: finalized.truncated,
					modelOverride: modelRef,
				}),
			},
			settleInput: {
				...baseSettleInput,
				// An explicit cancel is not a failure (P1-1) — the model asked this run to
				// stop, and it did.
				status: state.externallyCancelled ? "cancelled" : "failed",
				failureReason: effectiveFailureReason,
				outputText: finalText,
			},
		};
	}

	// P2-2, same as an external write run: what this run changed, so the reader does not spend
	// its first tool call finding out. Only a cleanly completed write run pays for it.
	const workspaceSummary =
		config.mutates === "write"
			? await changedPathsSummary(runContext.workingDirectory, input.workspaceBaseline).catch(() => undefined)
			: undefined;
	const workspaceLine = workspaceSummary
		? `\n\nWorkspace after the run (git status --porcelain): ${workspaceSummary}`
		: "";
	const finalized = finalizeSubAgentOutput(runContext, finalText);
	return {
		toolResult: {
			content: [
				{
					type: "text",
					text:
						mutatesNote +
						fallbackLine +
						(finalized.replyText || `(Sub-agent ${config.name} completed with no text output)`) +
						workspaceLine,
				},
			],
			details: createDetails({
				config,
				runContext,
				usage,
				turns: state.assistantTurns,
				toolCalls: state.toolCalls,
				durationMs,
				verificationVerdict,
				resultTruncated: finalized.truncated,
				modelOverride: modelRef,
			}),
		},
		settleInput: { ...baseSettleInput, status: "completed", outputText: finalText, workspaceSummary },
	};
}

/** Best-effort settle input for the one fatal path that rejects instead of resolving. */
export function fatalSettleInput(state: InternalRunState, error: Error): SettleInput {
	const { usage } = state;
	return {
		status: state.externallyCancelled ? "cancelled" : "failed",
		failureReason: state.failureReason || error.message,
		usage,
		usageKnown: true,
		costKnown: usage.cost.total > 0 || usage.total === 0,
		turns: state.assistantTurns,
		toolCalls: state.toolCalls,
		durationMs: Date.now() - state.startedAt,
		outputText: "",
		model: state.fallbackNote ? formatModelReference(state.activeModel) : undefined,
	};
}
