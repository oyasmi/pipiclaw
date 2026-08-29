import { estimateTokens } from "../shared/token-estimate.js";

export const PREVENTIVE_COMPACTION_THRESHOLD_RATIO = 0.75;

export interface PreventiveCompactionDecision {
	shouldCompact: boolean;
	projectedTokens: number | null;
	thresholdTokens: number;
	ratio: number;
}

/**
 * The incoming message's share of the projected context.
 *
 * Script-aware on purpose (shared with the prompt manifest): a flat characters-per-token ratio
 * put a 12k-character Chinese message at ~4k tokens instead of ~12k, so the projection stayed
 * under the threshold and the turn went in without compacting — the case preventive compaction
 * exists to catch, on this product's most common input.
 */
export function estimateIncomingMessageTokens(text: string): number {
	if (!text) {
		return 0;
	}
	return estimateTokens(text);
}

export function getPreventiveCompactionDecision(
	contextTokens: number | null | undefined,
	incomingTokens: number,
	contextWindow: number,
	thresholdRatio: number = PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
): PreventiveCompactionDecision {
	const normalizedContextWindow = Number.isFinite(contextWindow) ? Math.max(0, Math.floor(contextWindow)) : 0;
	const normalizedIncomingTokens =
		Number.isFinite(incomingTokens) && incomingTokens > 0 ? Math.floor(incomingTokens) : 0;
	const normalizedRatio =
		Number.isFinite(thresholdRatio) && thresholdRatio > 0
			? Math.min(thresholdRatio, 1)
			: PREVENTIVE_COMPACTION_THRESHOLD_RATIO;
	const thresholdTokens = Math.floor(normalizedContextWindow * normalizedRatio);

	if (contextTokens === null || contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens < 0) {
		return {
			shouldCompact: false,
			projectedTokens: null,
			thresholdTokens,
			ratio: normalizedRatio,
		};
	}

	const projectedTokens = Math.floor(contextTokens) + normalizedIncomingTokens;
	return {
		shouldCompact: normalizedContextWindow > 0 && projectedTokens >= thresholdTokens,
		projectedTokens,
		thresholdTokens,
		ratio: normalizedRatio,
	};
}
