export const PREVENTIVE_COMPACTION_THRESHOLD_RATIO = 0.75;

export interface PreventiveCompactionDecision {
	shouldCompact: boolean;
	thresholdTokens: number;
	ratio: number;
}

export function getPreventiveCompactionDecision(
	contextTokens: number | null | undefined,
	contextWindow: number,
	thresholdRatio: number = PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
): PreventiveCompactionDecision {
	const normalizedContextWindow = Number.isFinite(contextWindow) ? Math.max(0, Math.floor(contextWindow)) : 0;
	const normalizedRatio =
		Number.isFinite(thresholdRatio) && thresholdRatio > 0 ? Math.min(thresholdRatio, 1) : PREVENTIVE_COMPACTION_THRESHOLD_RATIO;
	const thresholdTokens = Math.floor(normalizedContextWindow * normalizedRatio);

	if (contextTokens === null || contextTokens === undefined || !Number.isFinite(contextTokens) || contextTokens < 0) {
		return {
			shouldCompact: false,
			thresholdTokens,
			ratio: normalizedRatio,
		};
	}

	return {
		shouldCompact: normalizedContextWindow > 0 && contextTokens >= thresholdTokens,
		thresholdTokens,
		ratio: normalizedRatio,
	};
}
