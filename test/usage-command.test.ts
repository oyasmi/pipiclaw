import { describe, expect, it } from "vitest";
import type { UsageLedger, UsageSummary, UsageSummaryQuery } from "../src/usage/ledger.js";
import { parseUsageMode, renderUsageReport, usageWindows } from "../src/usage/render.js";

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

describe("/usage command parsing", () => {
	it("maps args to a query mode", () => {
		expect(parseUsageMode("")).toBe("default");
		expect(parseUsageMode("7d")).toBe("7d");
		expect(parseUsageMode("month")).toBe("month");
		expect(parseUsageMode("garbage")).toBe("default");
	});
});

describe("usage windows", () => {
	it("default shows today + this month (host-local boundaries)", () => {
		const windows = usageWindows("default", NOW);
		expect(windows.map((w) => w.title)).toEqual(["今天", "本月（2026-07）"]);
		// NOW is 2026-07-04T12:00:00Z = 2026-07-04T20:00:00+08:00 under the pinned test TZ.
		expect(windows[0].since.toISOString()).toBe("2026-07-03T16:00:00.000Z");
		expect(windows[1].since.toISOString()).toBe("2026-06-30T16:00:00.000Z");
	});

	it("7d spans the last week", () => {
		const [window] = usageWindows("7d", NOW);
		expect(window.title).toBe("最近 7 天");
		expect(window.since.toISOString()).toBe("2026-06-27T12:00:00.000Z");
	});
});

describe("renderUsageReport", () => {
	it("renders channel + global cost with kind and model breakdowns", async () => {
		const ledger = stubLedger((q) =>
			q.channelId
				? { totalCost: 0.3, totalTokens: 12_000, entryCount: 2, byKind: { turn: 0.2, sidecar: 0.1 } }
				: {
						totalCost: 1.5,
						totalTokens: 2_400_000,
						entryCount: 5,
						byModel: { "anthropic/opus": 1.0, "anthropic/haiku": 0.5 },
						byChannel: { c1: 0.3, c2: 1.2 },
					},
		);

		const report = await renderUsageReport(ledger, "c1", "month", NOW);
		expect(report).toContain("本月（2026-07）");
		expect(report).toContain("本频道：$0.3000 · 12k tokens");
		expect(report).toContain("turn $0.2000 · sidecar $0.1000");
		expect(report).toContain("全局：$1.5000 · 2.4M tokens，覆盖 2 个频道");
		expect(report).toContain("用量最高的模型：anthropic/opus $1.0000，anthropic/haiku $0.5000");
	});

	it("reports empty windows plainly", async () => {
		const ledger = stubLedger(() => ({}));
		const report = await renderUsageReport(ledger, "c1", "default", NOW);
		expect(report).toContain("暂无用量记录。");
	});

	it("discloses runs with unknown cost/usage instead of silently folding them into the total (spec 040, T7)", async () => {
		const ledger = stubLedger((q) =>
			q.channelId
				? { totalCost: 0.2, totalTokens: 5_000, entryCount: 2, unknownCostCount: 2, unknownUsageCount: 1 }
				: { totalCost: 0.2, totalTokens: 5_000, entryCount: 2, unknownCostCount: 2, unknownUsageCount: 1 },
		);

		const report = await renderUsageReport(ledger, "c1", "month", NOW);
		expect(report).toContain("2 次成本未知");
		expect(report).toContain("1 次用量未知");
		expect(report).toContain("未计入以上合计");
	});

	it("omits the unknown-cost note when every run in the window has known usage and cost", async () => {
		const ledger = stubLedger((q) =>
			q.channelId
				? { totalCost: 0.3, totalTokens: 12_000, entryCount: 2 }
				: { totalCost: 1.5, totalTokens: 2_400_000, entryCount: 5 },
		);

		const report = await renderUsageReport(ledger, "c1", "month", NOW);
		expect(report).not.toContain("未知");
	});
});
