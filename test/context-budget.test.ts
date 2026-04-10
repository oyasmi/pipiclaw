import { describe, expect, it } from "vitest";
import { getPreventiveCompactionDecision, PREVENTIVE_COMPACTION_THRESHOLD_RATIO } from "../src/agent/context-budget.js";

describe("context budget", () => {
	it("skips preventive compaction when usage is below threshold", () => {
		expect(getPreventiveCompactionDecision(74_999, 100_000)).toEqual({
			shouldCompact: false,
			thresholdTokens: 75_000,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});

	it("triggers preventive compaction at the 75 percent threshold", () => {
		expect(getPreventiveCompactionDecision(75_000, 100_000)).toEqual({
			shouldCompact: true,
			thresholdTokens: 75_000,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});

	it("skips preventive compaction when context usage is unknown", () => {
		expect(getPreventiveCompactionDecision(null, 100_000)).toEqual({
			shouldCompact: false,
			thresholdTokens: 75_000,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});

	it("skips preventive compaction when the context window is invalid", () => {
		expect(getPreventiveCompactionDecision(90_000, 0)).toEqual({
			shouldCompact: false,
			thresholdTokens: 0,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});
});
