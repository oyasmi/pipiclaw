/**
 * DingTalk's delivery presets. `channel.json`'s `dingtalk.responseMode` picks how a turn is shown;
 * the two derived settings below are all the delivery code ever branches on.
 */

/** How progress is surfaced during a turn. */
export type ProgressStyle = "full" | "rolling" | "none";

/** How the final answer is delivered. */
export type FinalDelivery = "plain" | "card";

export type ResponseMode = "full_progress_then_plain_final" | "rolling_progress_then_plain_final" | "final_card_only";

const RESPONSE_MODE_VALUES: ResponseMode[] = [
	"full_progress_then_plain_final",
	"rolling_progress_then_plain_final",
	"final_card_only",
];

export function progressStyleOf(mode: ResponseMode): ProgressStyle {
	if (mode === "final_card_only") return "none";
	if (mode === "rolling_progress_then_plain_final") return "rolling";
	return "full";
}

export function finalDeliveryOf(mode: ResponseMode): FinalDelivery {
	return mode === "final_card_only" ? "card" : "plain";
}

export function isResponseModeConfig(value: unknown): value is ResponseMode {
	return typeof value === "string" && (RESPONSE_MODE_VALUES as string[]).includes(value);
}

export function normalizeResponseMode(value: unknown): ResponseMode {
	if (value === undefined) {
		return "full_progress_then_plain_final";
	}
	if (isResponseModeConfig(value)) {
		return value;
	}
	throw new Error(
		'Invalid `responseMode`: expected "full_progress_then_plain_final", "rolling_progress_then_plain_final", or "final_card_only".',
	);
}
