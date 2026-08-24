import { describe, expect, it } from "vitest";
import type { UsageLedger, UsageSummary, UsageSummaryQuery } from "../src/usage/ledger.js";
import { renderUsageReport, usageWindows } from "../src/usage/render.js";

const NOW = new Date("2026-07-04T12:00:00Z");

/** In-memory ledger stub that returns fixed per-query summaries. */
function stubLedger(fn: (q: UsageSummaryQuery) => Partial<UsageSummary>): UsageLedger {
	return {
		record: () => {},
		summarize: async (q) => ({
			totalCost: 0,
			totalTokens: 0,
			entryCount: 0,
			byKind: {},
			byModel: {},
			byChannel: {},
			byTask: {},
			unknownUsageCount: 0,
			unknownCostCount: 0,
			...fn(q),
		}),
	};
}

describe("usage command", () => {
	it("default window shows today + this month (host-local boundaries)", () => {
		const windows = usageWindows("default", NOW);
		expect(windows.map((w) => w.title)).toEqual(["今天", "本月（2026-07）"]);
		// NOW is 2026-07-04T12:00:00Z = 2026-07-04T20:00:00+08:00 under the pinned test TZ.
		expect(windows[0].since.toISOString()).toBe("2026-07-03T16:00:00.000Z");
		expect(windows[1].since.toISOString()).toBe("2026-06-30T16:00:00.000Z");
	});

	it("renders channel + global cost with kind and model breakdowns", async () => {
		const ledger = stubLedger((q) =>
			q.channelId
				? { totalCost: 0.3, totalTokens: 12_000, entryCount: 2, byKind: { turn: 0.2, sidecar: 0.1 } }
				: {
						totalCost: 1.5,
						totalTokens: 2_400_000,
						entryCount: 5,
						byModel: { "anthropic/opus": 1.0 },
						byChannel: { c1: 0.3, c2: 1.2 },
					},
		);

		const report = await renderUsageReport(ledger, "c1", "month", NOW);
		expect(report).toContain("本月（2026-07）");
		expect(report).toContain("本频道：$0.3000 · 12k tokens");
		expect(report).toContain("turn $0.2000 · sidecar $0.1000");
		expect(report).toContain("全局：$1.5000 · 2.4M tokens，覆盖 2 个频道");
	});
});
