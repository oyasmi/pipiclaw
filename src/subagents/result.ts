/**
 * Shaping what a delegation hands back: status lines, the "[Dispatched]" placeholder, failure and
 * stopped text, the reply-size budget, and the structured `details` payload.
 */
import { join } from "node:path";
import { formatModelReference } from "../models/utils.js";
import { clipTextByPromptUnits, countPromptUnits } from "../shared/prompt-units.js";
import type { UsageTotals } from "../usage/totals.js";
import type { ResolvedSubAgentConfig, SubAgentConfig } from "./discovery.js";
import type { SubAgentRunContext, SubAgentToolFields } from "./types.js";

/**
 * Reply budget for what a sub-agent hands back to its parent (spec 032 D4), measured in the
 * same prompt-unit currency as the system prompt budget (shared/prompt-units.ts). The full
 * output always lands on disk under the artifact directory regardless of this budget — this
 * only caps what gets echoed into the parent's context.
 */
export const MAX_SUBAGENT_RESULT_UNITS = 1_200;
/**
 * Character ceiling paired with the unit ceiling. `prompt-units.ts` notes that a long
 * separator-free run of letters/digits counts as a single unit, so a units-only budget can still
 * pass through an unbounded blob — every budget must bound units *and* chars (fix plan §2.4).
 */
export const MAX_SUBAGENT_RESULT_CHARS = 12_000;
const RESULT_TRUNCATION_HEAD_RATIO = 1;

export function formatStatus(agentName: string, text: string): string {
	return `Subagent ${agentName}: ${text}`;
}

/**
 * The "still running, don't wait or re-dispatch" reply shared by every dispatch path that hands
 * back a placeholder instead of the run's own result: external always takes this path (D2); an
 * internal run takes it once the sync grace window elapses (D2/D7). Only the runtime label
 * (`external, <harness>` vs `internal, async`) differs between the two.
 */
export function buildDispatchedText(
	runId: string,
	agentName: string,
	runtimeLabel: string,
	workingDirectory: string,
): string {
	return (
		`[Dispatched] runId=${runId}, agent ${agentName} (${runtimeLabel}), working directory ${workingDirectory}.\n` +
		"Status: running. This channel will be woken with the result and artifact path once it finishes.\n" +
		"Finish independent work and dispatches, then end the turn when only waiting remains; do not re-dispatch or poll to wait. " +
		'Inside a task step, use task_step_end outcome=park with ticket {"kind":"work"}.'
	);
}

export function buildFailureText(config: SubAgentConfig, reason: string, lastAssistantText: string): string {
	const trimmedLastText = lastAssistantText.trim();
	if (!trimmedLastText) {
		return `Sub-agent ${config.name} failed: ${reason}`;
	}
	return `Sub-agent ${config.name} failed: ${reason}\n\nLast output:\n${trimmedLastText}`;
}

export function buildStoppedText(config: SubAgentConfig, reason: string, finalText: string): string {
	const trimmedFinalText = finalText.trim();
	if (!trimmedFinalText) {
		return `Sub-agent ${config.name} stopped: ${reason}`;
	}
	return `[Sub-agent ${config.name} stopped: ${reason}]\n\n${trimmedFinalText}`;
}

export interface FinalizedSubAgentOutput {
	replyText: string;
	truncated: boolean;
}

/**
 * Spec 032 D4: the full text always lands on disk, independent of whether it fits the reply
 * budget. What comes back to the parent is capped at MAX_SUBAGENT_RESULT_UNITS; a reply over
 * budget is truncated with a pointer to the file a chatty sub-agent can no longer blow out the
 * parent's context.
 *
 * The file itself is written by `SubAgentRunManager.settle()` — the one settlement point both
 * runtimes share (spec 040 D1) — which always runs before this call's reply reaches the parent.
 * This function only needs the path, to point at it.
 *
 * Spec 046 D2.2 removed `returns: "artifact"` and the ARTIFACT marker protocol: a caller that
 * needs a specific output file states the path in the task text instead, the path external roles
 * already had to follow.
 */
export function finalizeSubAgentOutput(runContext: SubAgentRunContext, finalText: string): FinalizedSubAgentOutput {
	const outputPath = join(runContext.artifactDir, "output.md");

	if (countPromptUnits(finalText) <= MAX_SUBAGENT_RESULT_UNITS && finalText.length <= MAX_SUBAGENT_RESULT_CHARS) {
		return { replyText: finalText, truncated: false };
	}

	const clipped = clipTextByPromptUnits(finalText, MAX_SUBAGENT_RESULT_UNITS, {
		headRatio: RESULT_TRUNCATION_HEAD_RATIO,
		maxChars: MAX_SUBAGENT_RESULT_CHARS,
		marker: `\n\n[... truncated; full output saved at ${outputPath} ...]\n\n`,
	});
	return { replyText: clipped.text, truncated: true };
}

export function createDetails(input: {
	config: ResolvedSubAgentConfig;
	runContext: SubAgentRunContext;
	usage: UsageTotals;
	turns: number;
	toolCalls: number;
	durationMs: number;
	failed?: boolean;
	failureReason?: string;
	verificationVerdict?: "pass" | "fail";
	resultTruncated?: boolean;
	/** Set for the "[Dispatched]" placeholder returned instead of waiting on the run (D2). */
	dispatched?: boolean;
	/** External roles report their harness's own model string, never `formatModelReference`. */
	modelOverride?: string;
	toolsOverride?: string[];
}): SubAgentToolFields {
	return {
		agent: input.config.name,
		source: input.config.source,
		model:
			input.modelOverride ??
			(input.config.runtime === "external"
				? (input.config.externalModelRef ?? "default")
				: formatModelReference(input.config.model)),
		tools: input.toolsOverride ?? [...input.config.tools],
		turns: input.turns,
		toolCalls: input.toolCalls,
		durationMs: input.durationMs,
		failed: input.failed ?? false,
		failureReason: input.failureReason,
		usage: {
			...input.usage,
			cost: { ...input.usage.cost },
		},
		runId: input.runContext.runId,
		purpose: input.runContext.purpose,
		taskId: input.runContext.taskId,
		verificationVerdict: input.verificationVerdict,
		artifactDir: input.runContext.artifactDir,
		resultTruncated: input.resultTruncated ?? false,
		dispatched: input.dispatched,
	};
}
