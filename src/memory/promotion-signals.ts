const PROMOTION_SIGNAL_PATTERNS = [
	/以后/,
	/默认/,
	/记住/,
	/偏好/,
	/决定/,
	/确认/,
	/采用/,
	/不再/,
	/流程/,
	/步骤/,
	/规范/,
	/checklist/i,
	/每次/,
	/后续/,
	/待办/,
	/需要跟进/,
	/\bprefer(?:s|red|ence)?\b/i,
	/\bdefault\b/i,
	/\bremember\b/i,
	/\bdecision\b/i,
	/\badopt\b/i,
	/\bworkflow\b/i,
	/\bprocess\b/i,
	/\bnext steps?\b/i,
	/\bfollow[- ]?up\b/i,
];

export interface PromotionSignalScanResult {
	hasSignal: boolean;
	matchedSignals: string[];
}

export function scanPromotionSignals(text: string): PromotionSignalScanResult {
	const matchedSignals = PROMOTION_SIGNAL_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) =>
		pattern.toString(),
	);
	return {
		hasSignal: matchedSignals.length > 0,
		matchedSignals,
	};
}
