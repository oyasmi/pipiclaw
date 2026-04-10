import { describe, expect, it } from "vitest";
import {
	estimateIncomingMessageTokens,
	getPreventiveCompactionDecision,
	PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
} from "../src/agent/context-budget.js";

describe("context budget", () => {
	it("estimates incoming message tokens with a simple chars-per-token heuristic", () => {
		expect(estimateIncomingMessageTokens("")).toBe(0);
		expect(estimateIncomingMessageTokens("abc")).toBe(1);
		expect(estimateIncomingMessageTokens("abcd")).toBe(2);
	});

	it("skips preventive compaction when projected usage is below threshold", () => {
		expect(getPreventiveCompactionDecision(70_000, 4_999, 100_000)).toEqual({
			shouldCompact: false,
			projectedTokens: 74_999,
			thresholdTokens: 75_000,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});

	it("triggers preventive compaction when the incoming message crosses the 75 percent threshold", () => {
		expect(getPreventiveCompactionDecision(70_000, 5_000, 100_000)).toEqual({
			shouldCompact: true,
			projectedTokens: 75_000,
			thresholdTokens: 75_000,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});

	it("skips preventive compaction when context usage is unknown", () => {
		expect(getPreventiveCompactionDecision(null, 5_000, 100_000)).toEqual({
			shouldCompact: false,
			projectedTokens: null,
			thresholdTokens: 75_000,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});

	it("skips preventive compaction when the context window is invalid", () => {
		expect(getPreventiveCompactionDecision(90_000, 1_000, 0)).toEqual({
			shouldCompact: false,
			projectedTokens: 91_000,
			thresholdTokens: 0,
			ratio: PREVENTIVE_COMPACTION_THRESHOLD_RATIO,
		});
	});
});
