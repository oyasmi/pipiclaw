export const PREVENTIVE_COMPACTION_THRESHOLD_RATIO = 0.75;
const ESTIMATED_CHARS_PER_TOKEN = 3;

export interface PreventiveCompactionDecision {
	shouldCompact: boolean;
	projectedTokens: number | null;
	thresholdTokens: number;
	ratio: number;
}

export function estimateIncomingMessageTokens(text: string): number {
	if (!text) {
		return 0;
	}
	return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
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
