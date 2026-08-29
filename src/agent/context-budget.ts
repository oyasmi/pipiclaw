import { estimateTokens } from "../shared/token-estimate.js";

export const PREVENTIVE_COMPACTION_THRESHOLD_RATIO = 0.75;

/**
 * Rough per-image token cost (spec 049), used only to keep the preventive-compaction projection
 * honest when a turn carries inbound images — providers vary (roughly 250–1600 tokens per image
 * depending on resolution/provider), so this is a conservative single constant rather than a
 * per-provider table: the guard only needs to be in the right ballpark to decide whether to
 * compact before sending, not to predict the exact bill.
 */
export const ESTIMATED_TOKENS_PER_IMAGE = 1200;

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
export function estimateIncomingMessageTokens(text: string, imageCount: number = 0): number {
	const textTokens = text ? estimateTokens(text) : 0;
	return textTokens + Math.max(0, imageCount) * ESTIMATED_TOKENS_PER_IMAGE;
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
