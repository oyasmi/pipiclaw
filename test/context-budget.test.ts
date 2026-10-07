import { describe, expect, it } from "vitest";
import { estimateIncomingMessageTokens, getPreventiveCompactionDecision } from "../src/agent/context-budget.js";

describe("preventive compaction budget", () => {
	it("compacts before a large Chinese message pushes the context over the threshold", () => {
		// 100k window, 74k used: the message decides it. At ~12k tokens it crosses the 75k bar;
		// under the old estimate it read as ~4k and the turn ran with the context nearly full.
		const chinese = "中".repeat(12_000);
		expect(estimateIncomingMessageTokens(chinese)).toBe(12_000);
		expect(estimateIncomingMessageTokens("a".repeat(12_000))).toBe(3_000);

		const decision = getPreventiveCompactionDecision(74_000, estimateIncomingMessageTokens(chinese), 100_000);

		expect(decision.thresholdTokens).toBe(75_000);
		expect(decision.projectedTokens).toBe(86_000);
		expect(decision.shouldCompact).toBe(true);
		expect(
			getPreventiveCompactionDecision(10_000, estimateIncomingMessageTokens("你好"), 100_000).shouldCompact,
		).toBe(false);
	});
});
